# Backend-ia (chatbot inventario)

API Django del chatbot. Usa **solo DeepSeek** + Supabase.

## Arranque

```bat
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python manage.py runserver 8000
```

Health: http://127.0.0.1:8000/api/health/

## Stack

- LLM: DeepSeek
- Spell: RapidFuzz / TheFuzz / pyspellchecker / Autocorrect
- RAG: BM25
- Intent: Instructor
