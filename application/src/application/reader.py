"""
This code defines a DocumentReader class that performs the following tasks:

- Loads a document from a specified path.
- Splits the document into chunks using a CharacterTextSplitter.
- Adds the chunks to a VectorStore.
- Creates a retrieval chain that allows users to ask questions about the document.

The code also defines a configuration class (AppConfig) and an Llm class (which is not shown in the code).

Usage:

1. Create an instance of the DocumentReader class.
2. Call the askInDocument() method to ask a question about the document.

Example:

```python
# Create an instance of the DocumentReader class
reader = DocumentReader(pdf="patient_file.pdf")

# Ask a question about the document
answer = reader.askInDocument("What is the patient's age?")

# Print the answer
print(answer)
"""

import hashlib
import os
import threading
import time

from langchain_docling.loader import MetaExtractor

from src.application.config import AppConfig
from src.infrastructure.observability import get_metrics, start_span
from src.application.paths import safe_path
from src.application.tools import timed

from src.infrastructure.parsers.openparse import OpenParseDocumentLoader
from src.infrastructure.parsers.ollama_ocr import OllamaOcrDocumentLoader
from src.infrastructure.parsers.unstructured import UnstructuredDocumentLoader
from src.infrastructure.vectorial.client import VectorialDataBaseClient
from src.infrastructure.llm.base import LLMConnect
from src.infrastructure.llm.factory import get_llm_client
from langchain_core.vectorstores import VectorStoreRetriever
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from src.infrastructure.vectorial.database import (
    VectorialDataBase,
    sanitize_collection_name,
)

from slugify import slugify


class DocumentReader:
    """
    A class that reads documents and enables querying them using an LLM.

    Attributes:
        document_path (str): The path to the document.
        llm (Llm): An instance of the Llm class for performing language tasks.
        vecdb (VectorialDataBase): An instance of VectorialDataBase for vector storage and retrieval.
        default_loader (callable): The default loader type for documents.
        logger (Logger): A logger for tracking progress and errors.
    """

    document: str = ""
    collectionName: str = "medsyntisDocs"
    retriever = None
    additional_pdf = None
    docs_pdf: list[str] = []
    vecdb: VectorialDataBase

    _docling_converter = None
    _docling_chunker = None
    _docling_lock = threading.Lock()

    @classmethod
    def get_docling_components(cls, device: str = "cpu"):
        if cls._docling_converter is None:
            with cls._docling_lock:
                if cls._docling_converter is None:
                    from docling.chunking import HybridChunker
                    from docling_core.transforms.chunker.tokenizer.huggingface import (
                        HuggingFaceTokenizer,
                    )
                    from docling.datamodel.accelerator_options import AcceleratorOptions
                    from docling.datamodel.base_models import InputFormat
                    from docling.datamodel.pipeline_options import (
                        PdfPipelineOptions,
                        RapidOcrOptions,
                    )
                    from docling.document_converter import (
                        DocumentConverter,
                        PdfFormatOption,
                    )

                    print("Preloading RapidOCR models and Docling Converter...")
                    ocr_options = RapidOcrOptions()
                    accelerator_options = AcceleratorOptions(device=device)
                    pipeline_options = PdfPipelineOptions(
                        ocr_options=ocr_options,
                        accelerator_options=accelerator_options,
                    )
                    pipeline_options.allow_external_plugins = True

                    converter = DocumentConverter(
                        format_options={
                            InputFormat.PDF: PdfFormatOption(
                                pipeline_options=pipeline_options,
                            ),
                        },
                    )
                    chunker = None
                    try:
                        chunker = HybridChunker(
                            tokenizer=HuggingFaceTokenizer.from_pretrained(
                                model_name="intfloat/multilingual-e5-base",
                                local_files_only=True,
                                max_tokens=512,
                            )
                        )
                    except Exception:
                        try:
                            chunker = HybridChunker(
                                tokenizer=HuggingFaceTokenizer.from_pretrained(
                                    model_name="intfloat/multilingual-e5-base",
                                )
                            )
                        except Exception:
                            chunker = None
                    cls._docling_chunker = chunker
                    cls._docling_converter = converter
        return cls._docling_converter, cls._docling_chunker

    def _build_text_splitter(self) -> RecursiveCharacterTextSplitter:
        """Build a character text splitter configured from `config.rcp` chunk settings."""
        raw_chunk_size = getattr(self.config.rcp, "chunk_size", 1000)
        raw_chunk_overlap = getattr(self.config.rcp, "chunk_overlap", 150)
        chunk_size = (
            raw_chunk_size
            if isinstance(raw_chunk_size, int) and raw_chunk_size > 0
            else 1000
        )
        chunk_overlap = (
            raw_chunk_overlap
            if isinstance(raw_chunk_overlap, int)
            and 0 <= raw_chunk_overlap < chunk_size
            else min(150, max(0, chunk_size // 4))
        )
        return RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )

    @staticmethod
    def calculate_file_hash(file_path: str) -> str:
        """Calculates the SHA-256 hash of a file by reading chunks."""
        hasher = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    def __init__(
        self,
        config: AppConfig,
        document: str,
        document_type: str = "mtd",
        models=None,
        vecdb_client: VectorialDataBase | None = None,
        llm_client: LLMConnect | None = None,
    ):
        self.config = config
        self.document = document
        self.document_type = document_type
        self.current_model = None

        if document_type == "mtd":
            self.document_path = str(safe_path(config.rcp.path, document))
        elif document_type == "ressource":
            self.document_path = str(safe_path(config.rcp.additional_path, document))
        else:
            raise ValueError(f"{document_type} not yet supported")

        if vecdb_client is None:
            # pyrefly: ignore [bad-assignment]
            self.vecdb = VectorialDataBaseClient(
                config,
                coll_prefix=sanitize_collection_name(slugify(document, separator="_")),
            ).vectordb
        else:
            self.vecdb = vecdb_client

        if llm_client is None:
            llm_client_instance = get_llm_client(config)
            self.embeddings = llm_client_instance.embedding
        else:
            self.embeddings = llm_client.embedding

        self.logger = config.set_logger(
            "reader",
            default_context={
                "document": document,
                "embeddings": config.llm.embeddings,
                "parser": config.rcp.doc_type,
            },
        )

        self.metadata = {}

        self.default_loader = config.rcp.doc_type
        self.file_hash: str | None = None
        self.markdown_exporter: list[Document] = []
        self.chunked_documents: list[Document] = []

        self.logger.debug(
            f"Class reader succesfully init, Start reading document {self.document_path}"
        )

    def _load_document(
        self, document: str, loader_type: str | None = None
    ) -> list[Document]:
        """Loads a document from the specified path using the given loader type."""
        try:
            if loader_type is None:
                loader_type = self.default_loader
            if loader_type == "openparse":
                return OpenParseDocumentLoader(document).load()
            elif loader_type == "docling":
                converter, chunker = self.get_docling_components(
                    device=self.config.rcp.docling_device
                )

                conv_res = converter.convert(source=document)
                dl_doc = conv_res.document
                meta_extractor = MetaExtractor()

                self.markdown_exporter = [
                    Document(
                        page_content=dl_doc.export_to_markdown(image_placeholder=""),
                        metadata=meta_extractor.extract_dl_doc_meta(
                            file_path=document, dl_doc=dl_doc
                        ),
                    )
                ]

                if chunker is not None:
                    chunked_docs = [
                        Document(
                            page_content=chunker.contextualize(chunk=chunk),
                            metadata=meta_extractor.extract_chunk_meta(
                                file_path=document, chunk=chunk
                            ),
                        )
                        for chunk in chunker.chunk(dl_doc)
                    ]
                else:
                    chunked_docs = self._build_text_splitter().split_documents(
                        self.markdown_exporter
                    )

                del conv_res, dl_doc

                return chunked_docs
            elif loader_type in ("pymupdf", "fitz"):
                import fitz

                raw_docs: list[Document] = []
                with fitz.open(document) as pdf_doc:
                    for page_idx in range(len(pdf_doc)):
                        raw_page_text = pdf_doc[page_idx].get_text("text")
                        page_text = (
                            raw_page_text if isinstance(raw_page_text, str) else ""
                        )
                        if page_text.strip():
                            raw_docs.append(
                                Document(
                                    page_content=page_text,
                                    metadata={
                                        "source": document,
                                        "file": self.document,
                                        "page": page_idx + 1,
                                    },
                                )
                            )
                if raw_docs:
                    self.markdown_exporter = [
                        Document(
                            page_content="\n\n".join(
                                d.page_content for d in raw_docs if d.page_content
                            ),
                            metadata={"source": document, "file": self.document},
                        )
                    ]
                return self._build_text_splitter().split_documents(raw_docs)
            elif loader_type == "ollamaOcr":
                raw_docs = OllamaOcrDocumentLoader(document, self.config).load()
                if raw_docs:
                    self.markdown_exporter = [
                        Document(
                            page_content="\n\n".join(
                                d.page_content for d in raw_docs if d.page_content
                            ),
                            metadata={"source": document, "file": self.document},
                        )
                    ]
                return self._build_text_splitter().split_documents(raw_docs)
            elif loader_type in ("unstructured", "UnstructuredPDFLoader"):
                raw_docs = UnstructuredDocumentLoader(
                    document,
                    chunking_strategy="by_title",
                    max_characters=1000000,
                    include_orig_elements=False,
                ).load()
                if raw_docs:
                    self.markdown_exporter = [
                        Document(
                            page_content="\n\n".join(
                                d.page_content for d in raw_docs if d.page_content
                            ),
                            metadata={"source": document, "file": self.document},
                        )
                    ]
                return self._build_text_splitter().split_documents(raw_docs)
            else:
                raise ValueError(f"Unknown document loader type: {loader_type}")
        except Exception as e:
            self.logger.exception("Error in document load: %s", e)
            raise

    def get_retriever(self) -> VectorStoreRetriever:
        # pyrefly: ignore [missing-attribute, not-callable]
        return self.vecdb.get_retriever()

    def is_indexed(self) -> bool:
        """
        Checks if the document is indexed in the VectorStore.
        """
        # pyrefly: ignore [missing-attribute]
        return self.vecdb.is_indexed()

    def _get_file_hash(self) -> str | None:
        """Computes or returns the cached SHA-256 hash of the document file."""
        if self.file_hash is not None:
            return self.file_hash

        if os.path.exists(self.document_path):
            try:
                self.file_hash = self.calculate_file_hash(self.document_path)
            except Exception as e:
                self.logger.warning(
                    "Could not compute hash for %s: %s", self.document_path, e
                )
        return self.file_hash

    def _get_cached_document(self) -> dict | None:
        """Retrieves cached document parsing result from MongoDB using the file hash."""
        if self.config.rcp.display_type != "mongodb":
            return None

        file_hash = self._get_file_hash()
        if not file_hash:
            return None

        try:
            from src.infrastructure.documents.mongodb import Mongodb

            client = Mongodb(self.config)
            cached_entry = client.get_document_cache(file_hash)
            client.close()
            if isinstance(cached_entry, dict):
                cached_doc_type = cached_entry.get("doc_type")
                if (
                    isinstance(cached_doc_type, str)
                    and cached_doc_type
                    and isinstance(self.default_loader, str)
                    and cached_doc_type != self.default_loader
                ):
                    self.logger.info(
                        "Document cache doc_type mismatch for %s (cached=%s, current=%s); re-parsing.",
                        self.document,
                        cached_doc_type,
                        self.default_loader,
                    )
                    return None
            return cached_entry
        except Exception as e:
            self.logger.warning("Error querying document cache from MongoDB: %s", e)
            return None

    def _restore_from_cache(self, cached_entry: dict) -> None:
        """Restores reader Markdown exporter from a cached MongoDB entry."""
        markdown_content = cached_entry.get("markdown", "")
        self.logger.info(
            "Cache HIT for document %s (hash: %s...)",
            self.document,
            self.file_hash[:8] if self.file_hash else "",
        )
        self.markdown_exporter = [
            Document(
                page_content=markdown_content,
                metadata={
                    "source": self.document_path,
                    "file": self.document,
                    "file_hash": self.file_hash,
                },
            )
        ]

    def _save_to_cache(self, markdown: str) -> None:
        """Saves document markdown to MongoDB document_cache collection."""
        if self.config.rcp.display_type != "mongodb" or not markdown:
            return

        file_hash = self._get_file_hash()
        if not file_hash:
            return

        try:
            from src.infrastructure.documents.mongodb import Mongodb

            client = Mongodb(self.config)
            client.save_document_cache(
                file_hash=file_hash,
                file_name=self.document,
                markdown=markdown,
                document_type=getattr(self, "document_type", "mtd"),
                doc_type=(
                    self.default_loader
                    if isinstance(self.default_loader, str)
                    else None
                ),
            )
            client.close()
            self.logger.info(
                "Saved document %s to MongoDB document_cache (hash: %s...)",
                self.document,
                file_hash[:8],
            )
        except Exception as e:
            self.logger.warning("Error saving to document cache in MongoDB: %s", e)

    def clear_cache(self) -> None:
        """Deletes the cache entry for this document from MongoDB."""
        if self.config.rcp.display_type != "mongodb":
            return

        try:
            from src.infrastructure.documents.mongodb import Mongodb

            client = Mongodb(self.config)
            client.delete_document_cache(
                file_hash=self.file_hash, file_name=self.document
            )
            client.close()
            self.logger.info("Cleared document cache for %s", self.document)
        except Exception as e:
            self.logger.warning("Error clearing document cache in MongoDB: %s", e)

    @timed
    def read_document(self, force_reload: bool = False):
        """
        Reads a document from the specified loader and splits it into chunks.
        Then, adds the chunks to a VectorStore.
        Finally, creates a retrieval chain that allows users to ask questions about the document.

        If the document hash is already cached in MongoDB and the vector store is indexed,
        avoids re-running Docling and re-indexing.
        """
        self.logger.debug(f"Start reading document {self.document_path}")
        t0 = time.perf_counter_ns()
        domain = self.config.domain or "oncology"
        parser_name = self.default_loader or "docling"
        cache_hit = False

        with start_span(
            "medsyntis.document.parse_and_index",
            attributes={
                "medsyntis.domain": domain,
                "medsyntis.parser": parser_name,
                "medsyntis.doc_id": self.document,
                "medsyntis.document_type": self.document_type,
            },
        ) as span:
            try:
                cached_entry = None if force_reload else self._get_cached_document()

                # Cache HIT:
                if cached_entry is not None and cached_entry.get("markdown"):
                    self._restore_from_cache(cached_entry)

                    is_vecdb_indexed = False
                    try:
                        is_vecdb_indexed = self.is_indexed()
                    except Exception as e:
                        self.logger.warning("Error checking if vecdb is indexed: %s", e)

                    if is_vecdb_indexed and not force_reload:
                        cache_hit = True
                        if span.is_recording():
                            span.set_attribute("cache.hit", True)
                        self.logger.info(
                            "Vector DB already indexed for %s, skipping Docling & re-indexing.",
                            self.document,
                        )
                        self.current_model = self.config.llm.embeddings
                        return

                    self.logger.info(
                        "Vector DB not indexed for %s, parsing chunks to index vector store...",
                        self.document,
                    )

                # Cache MISS or Vector DB needs indexing:
                self.logger.info(
                    "Running document loader for %s (doc_type: %s)...",
                    self.document,
                    self.default_loader,
                )
                self.chunked_documents = self._load_document(self.document_path)
                if not self.markdown_exporter and self.chunked_documents:
                    self.markdown_exporter = [
                        Document(
                            page_content="\n\n".join(
                                doc.page_content
                                for doc in self.chunked_documents
                                if doc.page_content
                            ),
                            metadata={
                                "source": self.document_path,
                                "file": self.document,
                            },
                        )
                    ]

                if span.is_recording():
                    span.set_attribute("cache.hit", False)
                    span.set_attribute(
                        "medsyntis.chunk_count", len(self.chunked_documents)
                    )

                # pyrefly: ignore [missing-attribute]
                self.vecdb.add_chunked_to_collection(
                    self.chunked_documents, flush_before=True
                )
                self.current_model = self.config.llm.embeddings

                # Save to cache if markdown was produced
                markdown_content = ""
                if (
                    hasattr(self, "markdown_exporter")
                    and self.markdown_exporter
                    and len(self.markdown_exporter) > 0
                ):
                    markdown_content = self.markdown_exporter[0].page_content

                if markdown_content:
                    self._save_to_cache(markdown_content)
            finally:
                get_metrics().record_document_parse(
                    domain=domain,
                    parser=parser_name,
                    cache_hit=cache_hit,
                    duration_ms=(time.perf_counter_ns() - t0) / 1_000_000.0,
                )
