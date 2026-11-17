"""Backfill de embeddings pgvector para inventario.

Uso:
  python manage.py embed_inventario
  python manage.py embed_inventario --limit 50 --force
"""

from __future__ import annotations

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Genera embeddings locales y los guarda en inventario.embedding"

    def add_arguments(self, parser):
        parser.add_argument(
            "--limit",
            type=int,
            default=0,
            help="Máximo de filas a procesar (0 = todas)",
        )
        parser.add_argument(
            "--batch",
            type=int,
            default=32,
            help="Tamaño de lote para embeddear",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Re-embeddear aunque ya tengan vector",
        )
        parser.add_argument(
            "--only-missing",
            action="store_true",
            default=True,
            help="Solo filas sin embedding (default)",
        )

    def handle(self, *args, **options):
        from inventario.ai.embeddings import embed_passages, row_to_embed_text
        from inventario.supabase_client import (
            read_inventario,
            update_inventario_embedding,
        )

        limit = int(options.get("limit") or 0)
        batch_size = max(1, min(int(options.get("batch") or 32), 128))
        force = bool(options.get("force"))

        rows, error, _used = read_inventario(force=True)
        if error:
            self.stderr.write(self.style.ERROR(error))
            return
        if not rows:
            self.stdout.write("Inventario vacío.")
            return

        pending: list[dict] = []
        for row in rows:
            if not force and row.get("embedding") not in (None, "", []):
                continue
            if row.get("id") is None:
                continue
            pending.append(row)
            if limit and len(pending) >= limit:
                break

        total = len(pending)
        if not total:
            self.stdout.write(self.style.SUCCESS("Nada pendiente de embeddear."))
            return

        from inventario.ai.embeddings import embeddings_configured

        if not embeddings_configured():
            self.stderr.write(
                self.style.ERROR(
                    "Falta OPENAI_API_KEY en Backend-ia/.env "
                    "(modelo text-embedding-3-small, 1536 dims)."
                )
            )
            return

        self.stdout.write(
            f"Embeddeando {total} filas (OpenAI text-embedding-3-small)…"
        )
        ok = 0
        fail = 0
        for i in range(0, total, batch_size):
            chunk = pending[i : i + batch_size]
            texts = [row_to_embed_text(r) for r in chunk]
            try:
                vectors = embed_passages(texts)
            except Exception as exc:  # noqa: BLE001
                self.stderr.write(self.style.ERROR(f"Lote {i}: {exc}"))
                fail += len(chunk)
                continue
            for row, vec in zip(chunk, vectors):
                done, err = update_inventario_embedding(int(row["id"]), vec)
                if done:
                    ok += 1
                else:
                    fail += 1
                    self.stderr.write(
                        f"id={row.get('id')} etiqueta={row.get('etiqueta')}: {err}"
                    )
            self.stdout.write(f"  … {min(i + batch_size, total)}/{total}")

        self.stdout.write(
            self.style.SUCCESS(f"Listo. ok={ok} fail={fail} total={total}")
        )
