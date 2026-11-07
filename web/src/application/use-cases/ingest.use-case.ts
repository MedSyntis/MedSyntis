import type { BatchStatus, ClinicalDomain, PatientListItem } from "../../domain/types.js";
import type { MedsyntisApiPort, UploadFileInput } from "../ports/medsyntis-api.port.js";

export class IngestUseCase {
  constructor(private readonly api: MedsyntisApiPort) {}

  async listExistingPatients(domain: ClinicalDomain): Promise<PatientListItem[]> {
    return this.api.listPatients(domain, false);
  }

  async uploadBatch(
    files: UploadFileInput[],
    domain: ClinicalDomain,
    explicitBatchId?: string,
  ): Promise<{ batchId: string; filenames: string[] }> {
    const batchId =
      explicitBatchId || `batch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return this.api.uploadForms(files, batchId, domain);
  }

  async getBatchStatus(batchId: string, domain: ClinicalDomain): Promise<BatchStatus> {
    return this.api.getBatchStatus(batchId, domain);
  }
}
