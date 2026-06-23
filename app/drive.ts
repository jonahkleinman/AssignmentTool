/* ------------------------------------------------------------------ *
 *  Client-side Google Drive picker.
 *
 *  Uses Google Identity Services (token client) + the Google Picker API
 *  entirely in the browser. The teacher grants per-session read access,
 *  picks one file, and we download its bytes with the short-lived token
 *  and hand back a File — which then flows through the same /api/extract
 *  pipeline as a local upload. No tokens ever touch our server.
 *
 *  Gated behind NEXT_PUBLIC_GOOGLE_* env vars; when unset, the Drive
 *  button is hidden and the rest of the app works unchanged.
 * ------------------------------------------------------------------ */

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
const APP_ID = process.env.NEXT_PUBLIC_GOOGLE_APP_ID; // GCP project number (optional)
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** True when the env is configured enough to offer Drive at all. */
export function isDriveConfigured(): boolean {
  return Boolean(CLIENT_ID && API_KEY);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    google?: any;
    gapi?: any;
  }
}

const scriptCache = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  if (scriptCache.has(src)) return scriptCache.get(src)!;
  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
  scriptCache.set(src, promise);
  return promise;
}

let pickerLoaded: Promise<void> | null = null;

async function ensurePicker(): Promise<void> {
  await loadScript("https://apis.google.com/js/api.js");
  if (!pickerLoaded) {
    pickerLoaded = new Promise<void>((resolve) =>
      window.gapi.load("picker", { callback: () => resolve() }),
    );
  }
  return pickerLoaded;
}

/** Requests a fresh OAuth access token via the GIS token client. */
async function requestAccessToken(): Promise<string> {
  await loadScript("https://accounts.google.com/gsi/client");
  return new Promise<string>((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp: any) => {
        if (resp?.error) {
          reject(new Error(resp.error_description || resp.error));
          return;
        }
        resolve(resp.access_token);
      },
    });
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

interface PickedFile {
  id: string;
  name: string;
  mimeType: string;
}

/** Opens the Picker and resolves with the chosen file, or null if cancelled. */
async function showPicker(token: string): Promise<PickedFile | null> {
  await ensurePicker();
  const picker = window.google.picker;

  return new Promise<PickedFile | null>((resolve) => {
    const view = new picker.DocsView()
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false);

    let builder = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY as string)
      .setCallback((data: any) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.PICKED) {
          const doc = data[picker.Response.DOCUMENTS][0];
          resolve({
            id: doc[picker.Document.ID],
            name: doc[picker.Document.NAME],
            mimeType: doc[picker.Document.MIME_TYPE],
          });
        } else if (action === picker.Action.CANCEL) {
          resolve(null);
        }
      });

    if (APP_ID) builder = builder.setAppId(APP_ID);
    builder.build().setVisible(true);
  });
}

/** Native Google formats must be exported; we pull them down as plain text. */
const GOOGLE_DOC_PREFIX = "application/vnd.google-apps";

async function downloadFile(picked: PickedFile, token: string): Promise<File> {
  const headers = { Authorization: `Bearer ${token}` };
  let url: string;
  let outName = picked.name;
  let outType = picked.mimeType;

  if (picked.mimeType.startsWith(GOOGLE_DOC_PREFIX)) {
    url = `https://www.googleapis.com/drive/v3/files/${picked.id}/export?mimeType=text/plain`;
    outType = "text/plain";
    if (!/\.txt$/i.test(outName)) outName += ".txt";
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${picked.id}?alt=media`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Couldn't download "${picked.name}" from Drive.`);
  }
  const blob = await res.blob();
  return new File([blob], outName, { type: outType || blob.type });
}

/**
 * Full Drive flow: authorize, pick a file, download it. Resolves to a File
 * ready for extraction, or null if the teacher cancelled the picker.
 */
export async function pickFromGoogleDrive(): Promise<File | null> {
  if (!isDriveConfigured()) {
    throw new Error("Google Drive is not configured.");
  }
  const token = await requestAccessToken();
  const picked = await showPicker(token);
  if (!picked) return null;
  return downloadFile(picked, token);
}
