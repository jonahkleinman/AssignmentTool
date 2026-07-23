import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Firestore } from "@google-cloud/firestore";

import { parseLabelsFile, type LabelsFile } from "./types";

const LABELS_DIR = join(process.cwd(), "eval", "labels");
const LABELER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface LabelsStorage {
  loadLabels(labeler: string): Promise<LabelsFile | null>;
  saveLabels(file: LabelsFile): Promise<void>;
}

export function normalizeLabeler(value: string | undefined, fallback = "dev"): string {
  const candidate = value?.trim() ?? "";
  return LABELER_PATTERN.test(candidate) ? candidate : fallback;
}

function labelsPath(labeler: string): string {
  if (!LABELER_PATTERN.test(labeler)) throw new Error("Invalid labeler name.");
  return join(LABELS_DIR, `${labeler}.json`);
}

export const fileLabelsStorage: LabelsStorage = {
  async loadLabels(labeler) {
    try {
      return parseLabelsFile(JSON.parse(await readFile(labelsPath(labeler), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },

  async saveLabels(file) {
    const validated = parseLabelsFile(file);
    const path = labelsPath(validated.labeler);
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  },
};

let firestore: Firestore | undefined;

function getFirestore(): Firestore {
  if (firestore) return firestore;
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
  if (encoded) {
    const serviceAccount = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as {
      project_id: string;
      client_email: string;
      private_key: string;
    };
    firestore = new Firestore({
      projectId: serviceAccount.project_id,
      credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key,
      },
    });
    return firestore;
  }

  firestore = new Firestore({
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
  return firestore;
}

export const firestoreLabelsStorage: LabelsStorage = {
  async loadLabels(labeler) {
    const snapshot = await getFirestore()
      .collection(process.env.FIREBASE_LABELS_COLLECTION ?? "ragEvalLabels")
      .doc(normalizeLabeler(labeler, ""))
      .get();
    return snapshot.exists ? parseLabelsFile(snapshot.data()) : null;
  },

  async saveLabels(file) {
    const validated = parseLabelsFile(file);
    await getFirestore()
      .collection(process.env.FIREBASE_LABELS_COLLECTION ?? "ragEvalLabels")
      .doc(validated.labeler)
      .set(validated);
  },
};

function configuredStorage(): LabelsStorage {
  const configured = process.env.EVAL_LABEL_STORAGE?.trim().toLowerCase();
  if (configured === "file") return fileLabelsStorage;
  if (configured === "firestore") return firestoreLabelsStorage;
  if (process.env.NODE_ENV === "production") {
    throw new Error("EVAL_LABEL_STORAGE must be set to firestore in production.");
  }
  return fileLabelsStorage;
}

export async function loadLabels(labeler: string): Promise<LabelsFile | null> {
  return configuredStorage().loadLabels(labeler);
}

export async function saveLabels(file: LabelsFile): Promise<void> {
  return configuredStorage().saveLabels(file);
}
