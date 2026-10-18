import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PINNED_EXTENSIONS,
  codeEditorAssociations,
  extensionsToInstall,
  installedExtensionVersions,
  parsePinnedExtensions,
  syncExtensions,
  vsixUrl,
  type ExtensionSyncDependencies,
  type PinnedExtension,
} from "../../src/core/code-extensions.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const csv: PinnedExtension = { id: "janisdd.vscode-edit-csv", version: "0.11.9", sha256: sha("csv vsix") };
const pdf: PinnedExtension = { id: "mathematic.vscode-pdf", version: "0.2.6", sha256: sha("pdf vsix") };

describe("parsePinnedExtensions", () => {
  test("reads a list of exact pins", () => {
    expect(parsePinnedExtensions({ extensions: [csv, pdf] })).toEqual([csv, pdf]);
  });

  test("the shipped list parses, pins exact versions and names each extension once", () => {
    expect(PINNED_EXTENSIONS.length).toBeGreaterThan(0);
    for (const extension of PINNED_EXTENSIONS) expect(extension.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(PINNED_EXTENSIONS.map((extension) => extension.id.toLowerCase())).size).toBe(PINNED_EXTENSIONS.length);
  });

  test.each([
    ["no list", {}],
    ["a list that is not an array", { extensions: "janisdd.vscode-edit-csv" }],
    ["an id without a publisher", { extensions: [{ ...csv, id: "vscode-edit-csv" }] }],
    ["an id with a path in it", { extensions: [{ ...csv, id: "janisdd/../evil.x" }] }],
    ["a version range", { extensions: [{ ...csv, version: "^0.11.9" }] }],
    ["a latest tag", { extensions: [{ ...csv, version: "latest" }] }],
    ["a short checksum", { extensions: [{ ...csv, sha256: "abc123" }] }],
    ["a checksum that is not hex", { extensions: [{ ...csv, sha256: "z".repeat(64) }] }],
    ["the same extension twice in another case", { extensions: [csv, { ...csv, id: "Janisdd.Vscode-Edit-Csv" }] }],
  ])("refuses %s", (_name, value) => {
    expect(() => parsePinnedExtensions(value)).toThrow();
  });
});

describe("editor associations", () => {
  test("reads the patterns each extension takes over, keeping the pins comparable without them", () => {
    const [parsed] = parsePinnedExtensions({ extensions: [{ ...pdf, editorAssociations: { "*.pdf": "pdf.view" } }] });
    expect(parsed).toEqual({ ...pdf, editorAssociations: { "*.pdf": "pdf.view" } });
  });

  test.each([
    ["associations that are not an object", { ...pdf, editorAssociations: ["*.pdf"] }],
    ["an editor that is not a string", { ...pdf, editorAssociations: { "*.pdf": 1 } }],
    ["an empty pattern", { ...pdf, editorAssociations: { "": "pdf.view" } }],
  ])("refuses %s", (_name, entry) => {
    expect(() => parsePinnedExtensions({ extensions: [entry] })).toThrow();
  });

  test("refuses two extensions claiming one pattern", () => {
    expect(() => parsePinnedExtensions({ extensions: [{ ...csv, editorAssociations: { "*.csv": "a.b" } }, { ...pdf, editorAssociations: { "*.csv": "c.d" } }] })).toThrow();
  });

  test("merges every extension's patterns into one map", () => {
    const pinned = parsePinnedExtensions({ extensions: [{ ...csv, editorAssociations: { "*.csv": "a.b" } }, pdf, { ...pdf, id: "x.y", editorAssociations: { "*.pdf": "pdf.view" } }] });
    expect(codeEditorAssociations(pinned)).toEqual({ "*.csv": "a.b", "*.pdf": "pdf.view" });
  });

  test("the shipped list opens spreadsheets, office documents and PDFs in their viewers and leaves Markdown, images and archives as they were", () => {
    const associations = codeEditorAssociations(PINNED_EXTENSIONS);
    for (const pattern of ["*.csv", "*.tsv", "*.xlsx", "*.xls", "*.xlsm", "*.ods", "*.docx", "*.pptx"]) expect(associations[pattern]).toBe("cweijan.officeViewer");
    expect(associations["*.pdf"]).toBe("pdf.view");
    for (const pattern of ["*.md", "*.markdown", "*.svg", "*.zip", "*.jar", "*.tar", "*.class", "*.ttf"]) expect(associations[pattern]).toBe("default");
  });
});

describe("vsixUrl", () => {
  test("points at the pinned version's package on Open VSX", () => {
    expect(vsixUrl(csv)).toBe("https://open-vsx.org/api/janisdd/vscode-edit-csv/0.11.9/file/janisdd.vscode-edit-csv-0.11.9.vsix");
  });
});

describe("installedExtensionVersions", () => {
  test("reads each extension's id and version from the profile manifest, ids compared without case", () => {
    const manifest = [
      { identifier: { id: "Janisdd.vscode-edit-csv" }, version: "0.11.8", location: { scheme: "file", path: "/x" } },
      { identifier: { id: "megabrain.megabrain-bridge" }, version: "1.0.0" },
    ];
    expect(installedExtensionVersions(manifest)).toEqual(new Map([["janisdd.vscode-edit-csv", "0.11.8"], ["megabrain.megabrain-bridge", "1.0.0"]]));
  });

  test("skips malformed entries and treats a malformed manifest as empty", () => {
    expect(installedExtensionVersions([null, "x", { identifier: {} }, { identifier: { id: "a.b" } }])).toEqual(new Map());
    expect(installedExtensionVersions({ not: "an array" })).toEqual(new Map());
  });
});

describe("extensionsToInstall", () => {
  test("installs an extension the profile does not have", () => {
    expect(extensionsToInstall([csv, pdf], new Map([["mathematic.vscode-pdf", "0.2.6"]]))).toEqual([csv]);
  });

  test("replaces an installed extension at another version, older or newer", () => {
    expect(extensionsToInstall([csv], new Map([["janisdd.vscode-edit-csv", "0.11.8"]]))).toEqual([csv]);
    expect(extensionsToInstall([csv], new Map([["janisdd.vscode-edit-csv", "0.12.0"]]))).toEqual([csv]);
  });

  test("does nothing when every pin is installed at its version", () => {
    expect(extensionsToInstall([csv, pdf], new Map([["janisdd.vscode-edit-csv", "0.11.9"], ["mathematic.vscode-pdf", "0.2.6"]]))).toEqual([]);
  });
});

describe("syncExtensions", () => {
  let root = "";
  let extensions = "";
  let cache = "";

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-code-extensions-")));
    extensions = join(root, "profile", "extensions");
    cache = join(root, "vsix");
    mkdirSync(extensions, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const payloads: Record<string, string> = { [vsixUrl(csv)]: "csv vsix", [vsixUrl(pdf)]: "pdf vsix" };

  function fakes(overrides: Partial<ExtensionSyncDependencies> = {}) {
    const downloads: string[] = [];
    const installs: string[] = [];
    const dependencies: ExtensionSyncDependencies = {
      download: async (url, destination) => {
        downloads.push(url);
        const body = payloads[url];
        if (body === undefined) throw new Error(`unexpected download ${url}`);
        writeFileSync(destination, body);
      },
      install: async (vsix) => {
        installs.push(readFileSync(vsix, "utf8"));
      },
      isAlive: () => false,
      ...overrides,
    };
    return { dependencies, downloads, installs };
  }

  test("downloads, verifies and installs what the profile lacks, keeping the package for later profiles", async () => {
    const fake = fakes();
    const result = await syncExtensions([csv, pdf], extensions, cache, fake.dependencies);
    expect(result).toEqual({ installed: [csv.id, pdf.id], failed: [], skipped: false });
    expect(fake.installs).toEqual(["csv vsix", "pdf vsix"]);
    expect(readdirSync(cache).sort()).toEqual(["janisdd.vscode-edit-csv-0.11.9.vsix", "mathematic.vscode-pdf-0.2.6.vsix"]);
  });

  test("installs from the kept package without downloading again", async () => {
    await syncExtensions([csv], extensions, cache, fakes().dependencies);
    const fake = fakes();
    await syncExtensions([csv], join(root, "other", "extensions"), cache, fake.dependencies);
    expect(fake.downloads).toEqual([]);
    expect(fake.installs).toEqual(["csv vsix"]);
  });

  test("skips what is installed at its version", async () => {
    writeFileSync(join(extensions, "extensions.json"), JSON.stringify([{ identifier: { id: csv.id }, version: csv.version }]));
    const fake = fakes();
    const result = await syncExtensions([csv, pdf], extensions, cache, fake.dependencies);
    expect(result.installed).toEqual([pdf.id]);
    expect(fake.downloads).toEqual([vsixUrl(pdf)]);
  });

  test("never installs a package whose checksum does not match, and keeps none of it", async () => {
    const fake = fakes({ download: async (_url, destination) => writeFileSync(destination, "tampered") });
    const result = await syncExtensions([csv], extensions, cache, fake.dependencies);
    expect(fake.installs).toEqual([]);
    expect(result.installed).toEqual([]);
    expect(result.failed.map((failure) => failure.id)).toEqual([csv.id]);
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
  });

  test("replaces a kept package that no longer matches its checksum", async () => {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "janisdd.vscode-edit-csv-0.11.9.vsix"), "corrupted");
    const fake = fakes();
    const result = await syncExtensions([csv], extensions, cache, fake.dependencies);
    expect(fake.downloads).toEqual([vsixUrl(csv)]);
    expect(fake.installs).toEqual(["csv vsix"]);
    expect(result.failed).toEqual([]);
  });

  test("a failed download skips only that extension; the next run tries it again", async () => {
    const offline = fakes({
      download: async (url, destination) => {
        if (url === vsixUrl(csv)) throw new Error("getaddrinfo ENOTFOUND open-vsx.org");
        writeFileSync(destination, payloads[url] ?? "");
      },
    });
    const first = await syncExtensions([csv, pdf], extensions, cache, offline.dependencies);
    expect(first.installed).toEqual([pdf.id]);
    expect(first.failed).toEqual([{ id: csv.id, reason: "getaddrinfo ENOTFOUND open-vsx.org" }]);
    expect(readdirSync(cache)).toEqual(["mathematic.vscode-pdf-0.2.6.vsix"]);

    writeFileSync(join(extensions, "extensions.json"), JSON.stringify([{ identifier: { id: pdf.id }, version: pdf.version }]));
    const online = fakes();
    const second = await syncExtensions([csv, pdf], extensions, cache, online.dependencies);
    expect(online.downloads).toEqual([vsixUrl(csv)]);
    expect(second.installed).toEqual([csv.id]);
  });

  test("a failed install is reported and does not stop the others", async () => {
    const fake = fakes({
      install: async (vsix) => {
        if (readFileSync(vsix, "utf8") === "csv vsix") throw new Error("install failed");
      },
    });
    const result = await syncExtensions([csv, pdf], extensions, cache, fake.dependencies);
    expect(result).toEqual({ installed: [pdf.id], failed: [{ id: csv.id, reason: "install failed" }], skipped: false });
  });

  test("leaves the profile to a sync that is already running", async () => {
    mkdirSync(join(extensions, ".megabrain-sync.lock"));
    writeFileSync(join(extensions, ".megabrain-sync.lock", "owner"), "4242\n");
    const fake = fakes({ isAlive: (pid) => pid === 4242 });
    const result = await syncExtensions([csv], extensions, cache, fake.dependencies);
    expect(result).toEqual({ installed: [], failed: [], skipped: true });
    expect(fake.downloads).toEqual([]);
  });

  test("takes over the lock of a sync that died, and releases it when done", async () => {
    mkdirSync(join(extensions, ".megabrain-sync.lock"));
    writeFileSync(join(extensions, ".megabrain-sync.lock", "owner"), "4242\n");
    const fake = fakes();
    const result = await syncExtensions([csv], extensions, cache, fake.dependencies);
    expect(result.installed).toEqual([csv.id]);
    expect(existsSync(join(extensions, ".megabrain-sync.lock"))).toBe(false);
  });
});
