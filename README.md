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

## Muse (Meta) como el chatbot — igual que DeepSeek

1. Crea una key en [Meta Model API](https://dev.meta.ai) (`MODEL_API_KEY`, empieza con `LLM_`).
2. En `.env`:
   ```env
   LLM_PROVIDERS=muse,deepseek,groq
   MODEL_API_KEY=LLM_...
   MUSE_MODEL=muse-spark-1.3
   ```
3. Reinicia `runserver 8000`. Health debe listar `muse`.

Si Muse no responde o no está disponible en tu país, DeepSeek/Groq siguen como failover.

## OpenClaw gestiona el proyecto (código)

Para que OpenClaw edite/gestione Frontend+Backend con Muse Code (no es el chat de inventario; es el agente de desarrollo):

```bash
# Muse CLI
curl -fsSL https://dev.meta.ai/install.sh | bash
muse --version

# Plugin
openclaw plugins install @openclaw/muse
```

En Control UI: **Models → Meta → Muse Code** (login).  
Copia `openclaw.example.json5` a tu config y apunta `workspace` a la carpeta `IA`.

Resumen:
- **Chat inventario** → Django usa Muse vía `MODEL_API_KEY` (como DeepSeek).
- **Gestionar código** → OpenClaw + Muse Code sobre el repo.

## Seguridad

- `.env`, `.venv` y `db.sqlite3` están en `.gitignore`
- No subas dumps, CSV ni keys
- SQLite local de Django está vacío / regenerable; los datos de inventario viven en **tu** Supabase
