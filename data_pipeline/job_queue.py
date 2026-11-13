#!/usr/bin/env python3
"""
FireSync local job queue (Python standard library only).

This is a durable JSON-file queue for resumable pipeline work. It replaces the previous
Redis-based skeleton, which was never integrated and required an optional dependency.

It is deliberately small and honest:
  * jobs are persisted to one JSON file, written atomically;
  * a job starts as `pending`, becomes `running` only when dequeued, and reaches a terminal
    state only when the worker records a real result;
  * retries are counted, not simulated;
  * no worker pool is claimed here. run_pipeline.py performs the actual downloads.

It is optional. The Express server does not use it.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class Job:
    """A unit of resumable pipeline work (one product x one date window)."""

    product_id: str
    window_id: str
    start_date: str
    end_date: str
    bbox: str
    job_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    status: str = JobStatus.PENDING.value
    attempts: int = 0
    max_attempts: int = 3
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    error_message: Optional[str] = None
    records_downloaded: Optional[int] = None
    checksum: Optional[str] = None

    def key(self) -> str:
        return f"{self.product_id}|{self.window_id}|{self.bbox}"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Job":
        allowed = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in allowed})


class FileJobQueue:
    """A single-process durable queue backed by one JSON file."""

    VERSION = 1

    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._jobs: Dict[str, Job] = {}
        self._load()

    # ------------------------------------------------------------- persistence
    def _load(self) -> None:
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError):
            # A corrupt queue must not be silently replaced. Keep the bad file visible.
            raise
        for item in payload.get("jobs", []):
            job = Job.from_dict(item)
            self._jobs[job.job_id] = job

    def flush(self) -> None:
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        payload = {
            "version": self.VERSION,
            "updated_at": utc_now_iso(),
            "jobs": [job.to_dict() for job in self._jobs.values()],
        }
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        os.replace(tmp, self.path)

    # ---------------------------------------------------------------- queue ops
    def enqueue(self, job: Job) -> Job:
        with self._lock:
            existing = self._find_by_key(job.key())
            if existing:
                return existing
            self._jobs[job.job_id] = job
            self.flush()
            return job

    def _find_by_key(self, key: str) -> Optional[Job]:
        for job in self._jobs.values():
            if job.key() == key:
                return job
        return None

    def find(self, product_id: str, window_id: str, bbox: str) -> Optional[Job]:
        return self._find_by_key(f"{product_id}|{window_id}|{bbox}")

    def dequeue(self) -> Optional[Job]:
        """Return the oldest pending job and mark it running. No job is invented."""
        with self._lock:
            pending = [job for job in self._jobs.values() if job.status == JobStatus.PENDING.value]
            if not pending:
                return None
            pending.sort(key=lambda job: (job.created_at, job.job_id))
            return self._begin_locked(pending[0])

    def begin(self, job_id: str) -> Optional[Job]:
        """Mark one specific pending job running (used by the pipeline worker)."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status != JobStatus.PENDING.value:
                return job
            return self._begin_locked(job)

    def _begin_locked(self, job: Job) -> Job:
        job.status = JobStatus.RUNNING.value
        job.started_at = utc_now_iso()
        job.updated_at = job.started_at
        job.attempts += 1
        self.flush()
        return job

    def reset_for_retry(self, job_id: str) -> Optional[Job]:
        """Reopen a completed/failed job so a forced or resumed run can execute it again."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.status = JobStatus.PENDING.value
            job.completed_at = None
            job.error_message = None
            job.updated_at = utc_now_iso()
            self.flush()
            return job

    def mark_completed(self, job: Job, records_downloaded: int, checksum: Optional[str]) -> Job:
        with self._lock:
            stored = self._jobs[job.job_id]
            stored.status = JobStatus.COMPLETED.value
            stored.completed_at = utc_now_iso()
            stored.updated_at = stored.completed_at
            stored.records_downloaded = int(records_downloaded)
            stored.checksum = checksum
            stored.error_message = None
            self.flush()
            return stored

    def mark_failed(self, job: Job, error_message: str, retry: bool = True) -> Job:
        with self._lock:
            stored = self._jobs[job.job_id]
            stored.error_message = error_message
            stored.updated_at = utc_now_iso()
            if retry and stored.attempts < stored.max_attempts:
                stored.status = JobStatus.PENDING.value
            else:
                stored.status = JobStatus.FAILED.value
                stored.completed_at = stored.updated_at
            self.flush()
            return stored

    def cancel(self, job_id: str) -> Optional[Job]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status in {
                JobStatus.COMPLETED.value,
                JobStatus.FAILED.value,
                JobStatus.CANCELLED.value,
            }:
                return job
            job.status = JobStatus.CANCELLED.value
            job.completed_at = utc_now_iso()
            job.updated_at = job.completed_at
            self.flush()
            return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def all(self) -> List[Job]:
        return list(self._jobs.values())

    def stats(self) -> Dict[str, int]:
        counts = {status.value: 0 for status in JobStatus}
        for job in self._jobs.values():
            counts[job.status] = counts.get(job.status, 0) + 1
        counts["total"] = len(self._jobs)
        return counts

    def completed_keys(self) -> set:
        """Keys already completed, so a resumed run can skip them."""
        return {
            job.key()
            for job in self._jobs.values()
            if job.status == JobStatus.COMPLETED.value
        }


def main() -> int:
    """Diagnostic CLI: print queue statistics for an existing file. Creates nothing."""
    import argparse

    parser = argparse.ArgumentParser(description="Inspect a FireSync local job queue")
    parser.add_argument("path", help="Path to the JSON queue file")
    args = parser.parse_args()
    if not os.path.exists(args.path):
        print(f"No queue file at {args.path}. Nothing has been queued.")
        return 1
    queue = FileJobQueue(args.path)
    print(json.dumps(queue.stats(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
