from src.infrastructure.vectorial.mongodb import Mongodb
from src.infrastructure.vectorial.milvus import MilvusDB
from src.infrastructure.vectorial.database import VectorialDataBase

from src.application.config import AppConfig


# Define a class for working with vectorial databases.
class VectorialDataBaseClient:
    vectordb: VectorialDataBase

    def __init__(self, config: AppConfig, coll_prefix: str | None = None) -> None:
        db_type = config.dbvec.type.strip().lower()
        if db_type in ("chroma", "chromadb"):
            from src.infrastructure.vectorial.chromadb import Chromadb

            self.vectordb = Chromadb(config, coll_prefix)
        elif db_type == "mongodb":
            self.vectordb = Mongodb(config, coll_prefix)
        elif db_type == "milvus":
            self.vectordb = MilvusDB(config, coll_prefix)
        else:
            raise ValueError(f"{config.dbvec.type} not yet supported")
