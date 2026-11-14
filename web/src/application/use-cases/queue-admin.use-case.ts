import type { ClinicalDomain, QueueJobItem, QueueStats } from "../../domain/types.js";
import type { MedsyntisApiPort } from "../ports/medsyntis-api.port.js";

export interface QueueDashboardQueryOptions {
  page?: number;
  pageSize?: number;
  status?: string;
}

export interface QueueDashboardView {
  stats: QueueStats;
  jobs: QueueJobItem[];
  allDomains: boolean;
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  statusFilter: string;
}

const QUEUE_STATUS_SORT_RANK: Record<string, number> = {
  RUNNING: 0,
  PROCESSING: 0,
  PENDING: 1,
  FAILED: 2,
  COMPLETED: 3,
  CANCELLED: 4,
};

function computeFilteredTotal(stats: QueueStats, statusFilter: string): number {
  switch (statusFilter) {
    case "RUNNING":
      return stats.running;
    case "PENDING":
      return stats.pending;
    case "FAILED":
      return stats.failed;
    case "COMPLETED":
      return stats.completed;
    case "CANCELLED":
      return stats.cancelled;
    default:
      return stats.total;
  }
}

export class QueueAdminUseCase {
  constructor(private readonly api: MedsyntisApiPort) {}

  async getDashboard(
    domain: ClinicalDomain,
    allDomains = true,
    options?: QueueDashboardQueryOptions,
  ): Promise<QueueDashboardView> {
    const rawStatus = options?.status?.trim().toUpperCase() ?? "ALL";
    const statusFilter =
      rawStatus === "RUNNING" ||
      rawStatus === "PENDING" ||
      rawStatus === "FAILED" ||
      rawStatus === "COMPLETED" ||
      rawStatus === "CANCELLED"
        ? rawStatus
        : "ALL";
    const pageSize = Math.max(10, Math.min(200, Math.floor(options?.pageSize ?? 25)));
    const stats = await this.api.getQueueStats(domain, allDomains);
    const totalItems = computeFilteredTotal(stats, statusFilter);
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const page = Math.max(1, Math.min(totalPages, Math.floor(options?.page ?? 1)));
    const offset = (page - 1) * pageSize;

    const rawJobs = await this.api.listQueueJobs(domain, allDomains, {
      limit: pageSize,
      offset,
      status: statusFilter === "ALL" ? undefined : statusFilter,
    });

    const jobs = [...rawJobs].sort((a, b) => {
      const rankDiff =
        (QUEUE_STATUS_SORT_RANK[a.status.toUpperCase()] ?? 99) -
        (QUEUE_STATUS_SORT_RANK[b.status.toUpperCase()] ?? 99);
      if (rankDiff !== 0) return rankDiff;
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });

    return {
      stats,
      jobs,
      allDomains,
      page,
      pageSize,
      totalItems,
      totalPages,
      statusFilter,
    };
  }

  async retryJob(jobId: string, domain: ClinicalDomain): Promise<void> {
    await this.api.retryQueueJob(jobId, domain);
  }

  async cancelOrDeleteJob(jobId: string, domain: ClinicalDomain): Promise<void> {
    await this.api.cancelOrDeleteQueueJob(jobId, domain);
  }

  async cleanQueue(mode: "completed" | "failed" | "all", domain: ClinicalDomain): Promise<number> {
    return this.api.cleanQueue(mode, domain);
  }

  async releaseLocks(domain: ClinicalDomain): Promise<{ released: number }> {
    return this.api.releaseGpuLocks(domain);
  }
}
