from pathlib import Path
from slugify import slugify
from src.application.config import AppConfig
from src.application.reader import DocumentReader
from src.infrastructure.vectorial.client import VectorialDataBaseClient


class Ressources:
    """
    Service class to handle clinical / scientific reference resources.
    Manages listing resource files from the filesystem and inspecting/updating
    their index status within the vectorial database.
    """

    def __init__(self, config: AppConfig):
        self.config = config
        self.directory = Path(config.rcp.additional_path)

    @classmethod
    def list_from_config(cls, config: AppConfig) -> list[str]:
        """Safely list available PDF resource filenames when `config.rcp.additional_path` is configured."""
        rcp = getattr(config, "rcp", None)
        additional_path = getattr(rcp, "additional_path", None)
        if not isinstance(additional_path, (str, Path)):
            return []
        return cls(config).list_ressources()

    def list_ressources(self) -> list[str]:
        """
        List all available PDF resource filenames in the additional path directory,
        excluding hidden files/directories and non-PDF artifacts.
        """
        if not self.directory.exists():
            return []
        return sorted(
            [
                f.name
                for f in self.directory.iterdir()
                if f.is_file()
                and not f.name.startswith(".")
                and f.name.lower().endswith(".pdf")
            ]
        )

    def is_indexed(self, ressource: str) -> bool:
        """
        Check if a given resource has been indexed in the vector database.
        """
        try:
            reader = DocumentReader(
                self.config, document=ressource, document_type="ressource"
            )
            return reader.is_indexed()
        except Exception:
            return False

    def index_ressource(self, ressource: str) -> None:
        """
        Load, split, and index the selected resource into the vector database.
        """
        reader = DocumentReader(
            self.config, document=ressource, document_type="ressource"
        )
        reader.read_document()

    def drop_ressource_index(
        self, ressource: str, file_hash: str | None = None
    ) -> None:
        """Drop the vector collection and MongoDB document cache associated with `ressource`."""
        logger = self.config.set_logger("ressources")
        try:
            vecdb = VectorialDataBaseClient(
                self.config, coll_prefix=slugify(ressource, separator="_")
            ).vectordb
            if vecdb is not None and hasattr(vecdb, "delete_collection"):
                vecdb.delete_collection()
        except Exception as exc:
            logger.warning(
                "Could not drop vector collection for resource %s: %s",
                ressource,
                exc,
            )

        if self.config.rcp.display_type == "mongodb":
            try:
                from src.infrastructure.documents.mongodb import Mongodb

                client = Mongodb(self.config)
                client.delete_document_cache(file_hash=file_hash, file_name=ressource)
                client.close()
            except Exception as exc:
                logger.warning(
                    "Could not delete document_cache for resource %s: %s",
                    ressource,
                    exc,
                )
