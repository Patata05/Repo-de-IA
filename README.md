# Backend-ia (chatbot inventario)

API Django del chatbot. **No incluye base de datos ni claves**: al clonar, el inventario aparece vacío hasta que configures Supabase y un LLM.

## Requisitos

- Python 3.11+
- Cuenta Supabase (tabla `inventario`; esquema en el repo Frontend `supabase/*.sql`)
- Al menos un proveedor LLM (Groq / DeepSeek / Gemini) **o** Ollama local

## Arranque en otra laptop

```bat
git clone -b feature/backend <URL-DEL-REPO> Backend-ia
cd Backend-ia

python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

copy .env.example .env
```

Edita `.env` con tu URL/keys de Supabase y al menos una `*_API_KEY`.

```bat
python manage.py runserver 8000
```

Comprueba: http://127.0.0.1:8000/api/health/

## Frontend

El front (rama `feature/chatbot`) proxya a este backend en el puerto `8000`.  
En Frontend-ia: `CHAT_BACKEND_URL=http://127.0.0.1:8000`

## Seguridad

- `.env`, `.venv` y `db.sqlite3` están en `.gitignore`
- No subas dumps, CSV ni keys
- SQLite local de Django está vacío / regenerable; los datos de inventario viven en **tu** Supabase
