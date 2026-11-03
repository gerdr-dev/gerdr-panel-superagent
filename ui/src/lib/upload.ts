/** Stores a file the user pasted / dropped / picked on Gerdr's machine (the same upload the chat input uses). */
export async function upload(f: File): Promise<string> {
  const res = await fetch(`/api/fs/upload?name=${encodeURIComponent(f.name || "image.png")}`, { method: "POST", credentials: "same-origin", headers: { "X-Gerdr": "1" }, body: f });
  const data = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data.path as string;
}
