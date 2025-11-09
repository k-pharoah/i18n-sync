A lightweight CLI tool that scans a **source JSON file** (e.g. `en.json`) to **detect and fill missing translation keys** across locale files.

> ⚙️ Requires `OPENAI_API_KEY` in your `.env`

#### **Usage**
```bash
npx tsx i18n-sync.ts en.json --translate
```

#### **Future Improvements**
- 🧠 **Smarter placeholder handling** — pre-process placeholders like `{name}`, `%s`, `<b>`, etc. before sending them to the API, instead of relying on prompt instructions.
