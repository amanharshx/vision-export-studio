"""Provider registry and abstract base class."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from yolo_export_studio.core.jobs import ExportJob
from yolo_export_studio.core.preflight import CheckResult
from yolo_export_studio.core.routes import Route


@dataclass(frozen=True)
class SourceMatch:
    """Returned by a provider when it recognises a source file."""

    provider_id: str
    format_id: str
    path: Path
    display_name: str


class ExportProvider(ABC):
    """
    Abstract base for all export providers.
    GUI code calls detect_source / routes_for / preflight / build_job only.
    Workers call provider.run(job) inside the subprocess.
    """

    @property
    @abstractmethod
    def id(self) -> str: ...

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def detect_source(self, path: Path) -> SourceMatch | None:
        """Return SourceMatch if this provider handles path, else None. No ML imports."""

    @abstractmethod
    def routes_for(self, source: SourceMatch) -> list[Route]:
        """Return all routes available for this source."""

    @abstractmethod
    def preflight(self, route: Route, options: dict) -> list[CheckResult]:
        """Read-only dependency checks. Must not install anything."""

    @abstractmethod
    def build_job(
        self,
        source: Path,
        route: Route,
        options: dict,
        output_dir: Path,
    ) -> ExportJob:
        """Construct the job descriptor the worker will execute."""

    @abstractmethod
    def run(self, job: ExportJob) -> None:
        """Worker-side execution. Called inside the subprocess — never from GUI."""


# ---------------------------------------------------------------------------
# Global registry
# ---------------------------------------------------------------------------

_REGISTRY: dict[str, ExportProvider] = {}


def register_provider(provider: ExportProvider) -> None:
    """Register a provider. Called at import time by each provider module."""
    if provider.id in _REGISTRY:
        raise ValueError(f"Provider '{provider.id}' already registered")
    _REGISTRY[provider.id] = provider


def get_provider(provider_id: str) -> ExportProvider:
    """Retrieve a registered provider by ID. Raises KeyError if not found."""
    return _REGISTRY[provider_id]


def all_providers() -> list[ExportProvider]:
    """Return all registered providers in registration order."""
    return list(_REGISTRY.values())


def detect_source(path: Path) -> tuple[SourceMatch, ExportProvider] | None:
    """Ask each provider if it recognises path. Returns first match or None."""
    for provider in _REGISTRY.values():
        match = provider.detect_source(path)
        if match is not None:
            return match, provider
    return None
