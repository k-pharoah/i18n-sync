import { access, readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as dotenv from "dotenv";

dotenv.config();

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];
type TranslationKey = { key: string[]; value: string };

const apiKey = process.env.OPENAI_API_KEY ?? "";

const sourceFileName = process.argv[2] || "en.json";
const shouldTranslate = process.argv.includes("--translate");

async function main(): Promise<void> {
    let totalAdded = 0;
    let totalTranslated = 0;

    const i18nDir = await findTargetFolder(process.cwd(), "i18n");
    if (!i18nDir) {
        throw new Error("Could not find i18n directory");
    }

    const sourceJson: JsonObject = JSON.parse(
        await readFile(path.join(i18nDir as string, sourceFileName), "utf8")
    );

    const localeFileNames = (await readdir(i18nDir)).filter(
        (fileName) => fileName.endsWith(".json") && fileName !== sourceFileName
    );

    console.log(
        `[i18n] Starting sync for ${localeFileNames.length} locales...`
    );

    for (const localeFileName of localeFileNames) {
        try {
            const targetPath = path.join(i18nDir, localeFileName);
            const targetJson: JsonObject = JSON.parse(
                await readFile(targetPath, "utf8")
            );

            const keys: TranslationKey[] = [];
            addMissingKeys(sourceJson, targetJson, [], keys);

            let translatedCount = 0;

            if (shouldTranslate && keys.length > 0) {
                if (!apiKey) {
                    console.warn(
                        `[i18n] Skipping translation for ${localeFileName}: OPENAI_API_KEY not set.`
                    );
                } else {
                    translatedCount = await translateAndApply(
                        keys,
                        targetJson,
                        path.basename(sourceFileName, ".json"),
                        path.basename(localeFileName, ".json")
                    );
                }
            }

            const addedCount = keys.length;

            if (addedCount > 0 || translatedCount > 0) {
                await writeFile(
                    targetPath,
                    JSON.stringify(targetJson, null, 2) + "\n",
                    "utf8"
                );
                console.log(
                    `[i18n] ${localeFileName}: added ${addedCount}, translated ${translatedCount}.`
                );
            } else {
                console.log(`[i18n] ${localeFileName}: no changes.`);
            }

            totalAdded += addedCount;
            totalTranslated += translatedCount;
        } catch (error: any) {
            console.warn(
                `[i18n] ${localeFileName}: skipped due to error: ${error}`
            );

            continue;
        }
    }

    if (totalAdded === 0) {
        console.log("All locale files are already up to date.");
        process.exit(2);
    } else {
        console.log(
            `Done. Added ${totalAdded}. Translated ${totalTranslated}.`
        );
        process.exit(0);
    }
}

async function translateAndApply(
    keys: TranslationKey[],
    targetJson: JsonObject,
    sourceFile: string,
    targetFile: string
): Promise<number> {
    const BATCH_SIZE = 20;
    const totalBatches = Math.ceil(keys.length / BATCH_SIZE);

    let totalApplied = 0;

    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batchIndex = i / BATCH_SIZE + 1;
        const percent = Math.floor((batchIndex / totalBatches) * 100);
        const batch = keys.slice(i, i + BATCH_SIZE);

        for (const { key } of batch) {
            process.stdout.write(
                `\r[i18n] ${targetFile}: ${batchIndex}/${totalBatches} (${percent}%) → ${key
                    .join(".")
                    .padEnd(60)}`
            );
        }

        console.log();

        const translatedKeys: string[] = [];
        const toTranslate = batch.filter((key) => key.value.trim().length > 0);

        if (toTranslate.length > 0) {
            try {
                const translated = await callOpenAiTranslateBatch(
                    toTranslate.map((key) => key.value),
                    sourceFile,
                    targetFile
                );

                let i = 0;

                for (const item of batch) {
                    translatedKeys.push(
                        item.value.trim().length === 0 ? "" : translated[i++]
                    );
                }
            } catch {
                for (const item of batch) {
                    if (item.value.trim().length === 0) {
                        translatedKeys.push("");
                        continue;
                    }
                    try {
                        const [key] = await callOpenAiTranslateBatch(
                            [item.value],
                            sourceFile,
                            targetFile
                        );

                        translatedKeys.push(key);
                    } catch {
                        translatedKeys.push(item.value);
                        console.warn(
                            `[i18n] ${targetFile}: fallback for "${item.value}"`
                        );
                    }
                }
            }
        } else {
            for (let i = 0; i < batch.length; i++) {
                translatedKeys[i] = "";
            }
        }

        for (let i = 0; i < batch.length; i++) {
            const pathParts: string[] = batch[i].key;
            const value = translatedKeys[i];
            let current: any = targetJson;

            for (let j = 0; j < pathParts.length - 1; j++) {
                const key = pathParts[j];

                if (typeof current[key] !== "object" || current[key] === null)
                    current[key] = {};
                current = current[key];
            }

            current[pathParts[pathParts.length - 1]] = value;
            totalApplied++;
        }
    }

    return totalApplied;
}

async function findTargetFolder(
    startDir: string,
    targetDir: string
): Promise<string | null> {
    for (const entry of await readdir(startDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }

        const fullPath = path.join(startDir, entry.name);
        if (entry.name === targetDir) {
            return fullPath;
        }

        const found = await findTargetFolder(fullPath, targetDir);
        if (found) {
            return found;
        }
    }

    return null;
}

async function callOpenAiTranslateBatch(
    keys: string[],
    sourceLang: string,
    targetLang: string
): Promise<string[]> {
    const url = "https://api.openai.com";

    const messages = [
        {
            role: "system",
            content: "You are a localization engine. Output strict JSON only.",
        },
        {
            role: "user",
            content: JSON.stringify({
                rules: [
                    'Return JSON only: { "translations": string[] }',
                    "Keep array length and order",
                    `Translate from ${sourceLang} to ${targetLang}; detect if \"auto\"`,
                    "Preserve ICU placeholders {name}, plural blocks, printf %s %d %1$s, HTML tags, and markdown",
                    "Only translate human-readable strings; keep casing; empty in → empty out",
                ],
                inputs: keys,
            }),
        },
    ];

    const body = {
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages,
    };

    const response = await withRetries(async () => {
        const result = await fetchWithTimeout(`${url}/v1/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        if (!result.ok) {
            const text = await result.text().catch(() => result.statusText);
            throw new Error(`OpenAI ${result.status}: ${text}`);
        }
        return result.json();
    });

    const content: string = response?.choices?.[0]?.message?.content ?? "";
    let parsed: any;

    try {
        parsed = JSON.parse(content);
    } catch {
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
            parsed = JSON.parse(match[0]);
        }
    }

    if (
        !parsed ||
        !Array.isArray(parsed.translations) ||
        parsed.translations.length !== keys.length
    ) {
        throw new Error("Invalid translations payload.");
    }

    return parsed.translations as string[];
}

async function withRetries<T>(operation: () => Promise<T>): Promise<T> {
    const attempts = 3;

    for (let i = 1; i <= attempts; i++) {
        try {
            const result = await operation();
            return result;
        } catch (error: any) {
            if (i === attempts) {
                throw error;
            }

            await new Promise((result) => setTimeout(result, 400 * i));
        }
    }

    throw new Error("unreachable");
}

async function fetchWithTimeout(url: string, init: any) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function addMissingKeys(
    source: JsonObject,
    target: JsonObject,
    keyPath: string[],
    keys: TranslationKey[]
): void {
    for (const [key, sourceValue] of Object.entries(source)) {
        const currentPath = [...keyPath, key];
        const targetValue = (target as any)[key];

        if (isTypeObject(sourceValue)) {
            if (!isTypeObject(targetValue)) {
                (target as any)[key] = {};
            }

            addMissingKeys(
                sourceValue as JsonObject,
                (target as any)[key] as JsonObject,
                currentPath,
                keys
            );

            continue;
        }

        if (typeof sourceValue !== "string") {
            continue;
        }

        if (typeof targetValue === "string" && targetValue.length > 0) {
            continue;
        }

        (target as any)[key] = "";
        keys.push({ key: currentPath, value: sourceValue });
    }
}

function isTypeObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
