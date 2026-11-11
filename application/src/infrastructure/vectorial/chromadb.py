import chromadb
from langchain_chroma import Chroma

from src.application.config import AppConfig
from src.infrastructure.vectorial.database import VectorialDataBase


class Chromadb(VectorialDataBase):
    def init_client(self, config: AppConfig):
        if config.chromadb.client == "HttpClient":
            self.client = chromadb.HttpClient(
                host=config.chromadb.host, port=config.chromadb.port
            )
        elif config.chromadb.client == "PersistentClient":
            self.client = chromadb.PersistentClient()

    def get_embedding(self):
        return self.llm_embeddings

    def delete_collection(self) -> None:
        """Delete the Chroma collection if it exists."""
        try:
            self.client.delete_collection(self.coll_name)
        except Exception:
            pass

    def set_clientdb(
        self,
        flush=False,
    ):
        if flush:
            self.logger.debug("Flushing collection")
            self.delete_collection()
        self.clientdb = Chroma(
            client=self.client,
            collection_name=self.coll_name,
            embedding_function=self.embeddings,
        )
        self.collection = self.clientdb

    def is_indexed(self) -> bool:
        try:
            col = self.client.get_collection(self.coll_name)
            return col.count() > 0
        except Exception:
            return False
