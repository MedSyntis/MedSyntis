from langchain_mongodb import MongoDBAtlasVectorSearch

from src.application.config import AppConfig
from src.infrastructure.documents.mongodb import get_mongo_client
from src.infrastructure.vectorial.database import VectorialDataBase


class Mongodb(VectorialDataBase):
    """
    A class for interacting with a MongoDB database using PyMongo.

    This class initializes a connection to a MongoDB database specified by the provided configuration,
    and provides methods for inserting documents into collections, logging information about the
    connection and operations performed, and closing the database connection when done.
    """

    def init_client(self, config: AppConfig) -> None:
        self.client = get_mongo_client(config)
        self.mongo_database = self.client[config.mongodb.vectordatabase]
        self.mongo_collection = self.mongo_database[self.coll_name]
        self._collection = self.mongo_collection

    def get_embedding(self):
        return self.llm_embeddings

    def delete_collection(self) -> None:
        """Drop the underlying MongoDB vector collection if present."""
        if getattr(self, "_collection", None) is not None:
            self._collection.drop()

    def set_clientdb(
        self,
        flush=False,
    ):
        if flush:
            self.delete_collection()
        self.database = self.client[self.coll_name]

        self.clientdb = MongoDBAtlasVectorSearch(
            collection=self.mongo_collection,
            embedding=self.embeddings,
            index_name=f"{self.coll_name}_idx",
            relevance_score_fn="cosine",
        )
        self.collection = self.clientdb
        self.clientdb.create_vector_search_index(dimensions=1536)
