import unittest
from unittest.mock import MagicMock, patch
from src.application.ressources import Ressources


class TestRessources(unittest.TestCase):
    def setUp(self):
        self.mock_config = MagicMock()
        self.mock_config.rcp.additional_path = "/mock/path/to/ressources"
        self.ressources_manager = Ressources(self.mock_config)

    @patch("src.application.ressources.Path.exists")
    @patch("src.application.ressources.Path.iterdir")
    def test_list_ressources(self, mock_iterdir, mock_exists):
        # Case 1: Directory does not exist
        mock_exists.return_value = False
        self.assertEqual(self.ressources_manager.list_ressources(), [])

        # Case 2: Directory exists with files
        mock_exists.return_value = True

        file1 = MagicMock()
        file1.is_file.return_value = True
        file1.name = "TNCDPANCREAS.pdf"

        file2 = MagicMock()
        file2.is_file.return_value = True
        file2.name = "TNCDOESOPHAGE.pdf"

        hidden_file = MagicMock()
        hidden_file.is_file.return_value = True
        hidden_file.name = ".gitignore"

        dir1 = MagicMock()
        dir1.is_file.return_value = False
        dir1.name = "some_directory"

        mock_iterdir.return_value = [file1, file2, hidden_file, dir1]

        # Should only list normal files, sorted alphabetically
        expected = ["TNCDOESOPHAGE.pdf", "TNCDPANCREAS.pdf"]
        self.assertEqual(self.ressources_manager.list_ressources(), expected)

    @patch("src.application.ressources.DocumentReader")
    def test_is_indexed(self, mock_document_reader_cls):
        mock_reader = MagicMock()
        mock_document_reader_cls.return_value = mock_reader

        # Case 1: Indexed returns True
        mock_reader.is_indexed.return_value = True
        self.assertTrue(self.ressources_manager.is_indexed("TNCDPANCREAS.pdf"))
        mock_document_reader_cls.assert_called_with(
            self.mock_config, document="TNCDPANCREAS.pdf", document_type="ressource"
        )

        # Case 2: Indexed returns False
        mock_reader.is_indexed.return_value = False
        self.assertFalse(self.ressources_manager.is_indexed("TNCDPANCREAS.pdf"))

        # Case 3: Exception raised, should catch and return False
        mock_reader.is_indexed.side_effect = Exception("DB Connection Error")
        self.assertFalse(self.ressources_manager.is_indexed("TNCDPANCREAS.pdf"))

    @patch("src.application.ressources.DocumentReader")
    def test_index_ressource(self, mock_document_reader_cls):
        mock_reader = MagicMock()
        mock_document_reader_cls.return_value = mock_reader

        self.ressources_manager.index_ressource("TNCDPANCREAS.pdf")
        mock_document_reader_cls.assert_called_with(
            self.mock_config, document="TNCDPANCREAS.pdf", document_type="ressource"
        )
        mock_reader.read_document.assert_called_once()

    def test_background_resource_index_enqueue_and_execution(self):
        from src.application.config import AppConfig
        from src.application.use_cases.queue_executor import (
            PatientMDTFormQueueJobExecutor,
        )
        from src.domain.worker import JobType
        from src.infrastructure.queue.memory_queue import InMemoryQueueManager

        base_conf = AppConfig()
        queue_mgr = InMemoryQueueManager(base_config=base_conf)

        first = queue_mgr.enqueue_resource_index("TNCDCHC.pdf", domain="oncology")
        assert first["already_queued"] is False
        assert first["job"]["job_type"] == JobType.RESOURCE_INDEX.value
        assert first["job"]["filename"] == "TNCDCHC.pdf"

        second = queue_mgr.enqueue_resource_index("TNCDCHC.pdf", domain="oncology")
        assert second["already_queued"] is True
        assert second["job"]["job_id"] == first["job"]["job_id"]

        executor = PatientMDTFormQueueJobExecutor(base_conf)
        with patch("src.application.ressources.Ressources.index_ressource") as mock_idx:
            executor.execute_resource_index(first["job"], "lease-1", queue_mgr)
            mock_idx.assert_called_once_with("TNCDCHC.pdf")

    def test_index_resource_endpoint_returns_202_and_enqueues(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from src.application.config import AppConfig
        from src.routers.dependencies import get_domain_config
        from src.routers.resources import router as resources_router

        app = FastAPI()
        app.include_router(resources_router, prefix="/api/v1")
        conf = AppConfig()
        app.dependency_overrides[get_domain_config] = lambda: conf

        fake_queue = MagicMock()
        fake_queue.enqueue_resource_index.return_value = {
            "already_queued": False,
            "job": {"job_id": "job_idx123", "status": "PENDING"},
        }
        with (
            patch(
                "src.routers.resources.Ressources.list_ressources",
                return_value=["TNCDCHC.pdf"],
            ),
            patch("src.routers.resources.safe_path", return_value="/tmp/TNCDCHC.pdf"),
            patch(
                "src.routers.resources.get_global_queue_manager",
                return_value=fake_queue,
            ),
        ):
            client = TestClient(app)
            resp = client.post("/api/v1/resources/TNCDCHC.pdf/index?domain=oncology")
            assert resp.status_code == 202
            body = resp.json()
            assert body["filename"] == "TNCDCHC.pdf"
            assert body["job_id"] == "job_idx123"
            assert body["status"] == "PENDING"
            assert body["already_queued"] is False
            fake_queue.enqueue_resource_index.assert_called_once_with(
                "TNCDCHC.pdf", domain="oncology"
            )
