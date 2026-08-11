export interface AppBundle {
  entry: string;
  files: Record<string, string>;
}

export interface SearchReplacePatch {
  path: string;
  search: string;
  replace: string;
}

export function assertSafeBundlePath(filePath: string): string {
  if (!filePath || filePath.includes("\\") || filePath.startsWith("/") || filePath.split("/").includes("..")) {
    throw new Error("不安全的应用文件路径");
  }
  const normalized = filePath.split("/").filter(Boolean).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("versions/") || normalized === "session.json") {
    throw new Error("不允许修改该应用文件");
  }
  return normalized;
}

export function bundleFromHtml(html: string): AppBundle {
  return { entry: "index.html", files: { "index.html": html } };
}

export function applySearchReplace(bundle: AppBundle, patches: SearchReplacePatch[]): AppBundle {
  const files = { ...bundle.files };
  for (const patch of patches) {
    const path = assertSafeBundlePath(patch.path);
    if (!(path in files)) throw new Error(`文件不存在：${path}`);
    if (!patch.search) throw new Error(`SEARCH 不能为空：${path}`);
    const count = files[path].split(patch.search).length - 1;
    if (count !== 1) throw new Error(`SEARCH 必须唯一匹配：${path}（当前 ${count} 次）`);
    files[path] = files[path].replace(patch.search, patch.replace);
  }
  return { entry: bundle.entry, files };
}
