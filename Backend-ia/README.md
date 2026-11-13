# Backend-ia (chatbot inventario)

API Django del chatbot. **No incluye base de datos ni claves**: al clonar, el inventario aparece vacío hasta que configures Supabase y DeepSeek.

## Requisitos

- Python 3.11+
- Cuenta Supabase (tabla `inventario`; esquema en el repo Frontend `supabase/*.sql`)
- `DEEPSEEK_API_KEY` ([platform.deepseek.com](https://platform.deepseek.com/api_keys))

## Arranque

```bat
cd Backend-ia
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Edita `.env` con Supabase + `DEEPSEEK_API_KEY`.

```bat
python manage.py runserver 8000
```

Health: http://127.0.0.1:8000/api/health/

## Frontend

En Frontend-ia: `CHAT_BACKEND_URL=http://127.0.0.1:8000`

## Stack activo

- LLM: **solo DeepSeek** (`deepseek-chat` / `deepseek-reasoner`)
- Spell: RapidFuzz, TheFuzz, pyspellchecker, Autocorrect
- RAG: **BM25** (sin Torch / Chroma / FAISS)
- Intent: Instructor + Pydantic (temp 0)

## Seguridad

- `.env`, `.venv` y `db.sqlite3` están en `.gitignore`
- No subas dumps, CSV ni keys
