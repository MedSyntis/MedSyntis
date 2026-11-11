import hashlib
import re
import uuid
from typing import Any

from langchain_core.documents import Document
from langchain_core.vectorstores import VectorStore, VectorStoreRetriever

from src.application.config import AppConfig
from src.infrastructure.llm.factory import get_llm_client


def sanitize_collection_name(raw_name: str) -> str:
    """
    Sanitize a vector collection name for Milvus and Chroma compatibility:
    - Restrict characters to `[a-zA-Z0-9_]`.
    - Prefix `doc_` when the first character is not `[a-zA-Z_]` (e.g. digit-prefixed filenames).
    - Truncate names longer than 240 characters using a deterministic `_{sha256[:12]}` suffix.
    """
    cleaned = re.sub(r"[^a-zA-Z0-9_]", "_", (raw_name or "").strip())
    if not cleaned:
        cleaned = "doc_unknown"
    elif not (cleaned[0].isalpha() or cleaned[0] == "_"):
        cleaned = f"doc_{cleaned}"
    if len(cleaned) > 240:
        digest = hashlib.sha256(cleaned.encode("utf-8")).hexdigest()[:12]
        cleaned = f"{cleaned[:227]}_{digest}"
    return cleaned


class VectorialDataBase:
    client: Any = None
    clientdb: VectorStore
    collection: Any = None

    """Initialize the client, collection and embeddings based on configuration."""

    def __init__(self, config: AppConfig, coll_prefix: str | None = None):

        embedding_suffix = (
            config.llm.embeddings.replace("/", "_").replace(":", "_").replace("-", "_")
        )
        if coll_prefix is None:
            raw_coll_name = f"{config.dbvec.collection}_{embedding_suffix}"
        else:
            raw_coll_name = (
                f"{coll_prefix}_{config.dbvec.collection}_{embedding_suffix}"
            )
        self.coll_name = sanitize_collection_name(raw_coll_name)

        llm_client = get_llm_client(config)
        self.llm_embeddings = llm_client.embedding

        self.config = config
        self.embeddings = self.get_embedding()

        # Initialize the logger early so that subclass init_client calls can safely log warning/retry messages
        self.logger = config.set_logger(
            "vectorial_db",
            default_context={
                "collection": self.coll_name,
                "embeddings": config.llm.embeddings,
                "db_type": config.dbvec.type.lower(),
            },
        )

        self.init_client(config)
        self.set_clientdb()

        db_version = "unknown"
        try:
            db_version = self.get_version()
        except Exception:
            pass

        self.logger.info(
            "Class vectorial_db succesfully init - server version: %s", db_version
        )

    def init_client(self, config: AppConfig):
        """
        Set init client
        """
        return None

    def get_embedding(self) -> Any:
        """Get embedding function."""
        raise NotImplementedError("Subclasses must implement get_embedding")

    def get_version(self) -> str:
        if self.client is None:
            return "unknown"
        return self.client.get_version()

    def set_clientdb(self, flush=False):
        """
        Set the clientdb based on the initialized client, collection and embeddings.

        Parameters:
        flush (bool): Whether to delete and recreate the collection. Defaults to False.

        Returns: None

        Raises:
        ValueError: If the client type is not supported
        """
        return None

    def get_retriever(self, words_number=2) -> VectorStoreRetriever:
        """
        Returns a VectorStoreRetriever instance for this vectorial database.

        This method creates a retriever that can be used to fetch vectors from the underlying database. The retriever is
        bound to this specific database, so all operations will be performed on the data stored in this database.

        :return: A VectorStoreRetriever instance
        """
        self.logger.debug("Return receiver with words_number=%s", str(words_number))
        return self.clientdb.as_retriever(
            # search_kwargs={"k": words_number, "fetch_k": 5}, search_type="mmr"
            search_type="similarity_score_threshold",
            search_kwargs={"score_threshold": 0.8},
        )

    def is_indexed(self) -> bool:
        """
        Checks if the collection exists and has indexed entities.
        """
        return False

    def delete_collection(self) -> None:
        """Delete the underlying vector collection if supported by the backend."""
        return None

    # Add a document to the collection.

    def add_to_collection(self, doc, flush_before=False):
        """
        Adds a document to the collection.

        Args:
        - doc (object): The document to be added.
        - flush_before (bool, optional): Whether to flush and recreate the clientdb before adding the document. Defaults to False.

        Returns: None
        """
        if flush_before:
            # Flush and recreate the clientdb before adding the document.
            self.set_clientdb(flush=True)

        # Add the document to the collection with metadata and page content.

        self.collection.add(
            ids=[str(uuid.uuid1())], metadatas=doc.metadata, documents=doc.page_content
        )

    def _add_documents_batch(self, batch: list[Document]) -> None:
        """Insert a bounded batch of LangChain `Document` chunks into the vector collection."""
        if self.collection is not None and hasattr(self.collection, "add_documents"):
            self.collection.add_documents(batch)
        elif (
            hasattr(self, "clientdb")
            and self.clientdb is not None
            and hasattr(self.clientdb, "add_documents")
        ):
            self.clientdb.add_documents(batch)
        else:
            for doc in batch:
                self.add_to_collection(doc)

    def add_chunked_to_collection(self, chunked_documents, flush_before=False):
        """
        Add a chunked list of documents to the collection in batches of 32.

        Parameters:
            - chunked_documents: A list of documents that need to be added to the collection
            - flush_before (Optional): If True, the clientdb is flushed before adding the documents

        Returns:
            None
        """
        if flush_before:
            self.set_clientdb(flush=True)
        docs = [
            Document(metadata=doc.metadata, page_content=doc.page_content)
            for doc in (chunked_documents or [])
        ]
        if not docs:
            return
        batch_size = 32
        for idx in range(0, len(docs), batch_size):
            batch = docs[idx : idx + batch_size]
            self._add_documents_batch(batch)
