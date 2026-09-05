"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const SCANNER_VERSION = 1;
const FORBIDDEN_SCANNER_FIELDS = [
    "markerScheme",
    "markerEvidence",
    "sourceUnreadByVariant",
    "isUpdated",
];
const SENSITIVE_FIXTURE_PATTERNS = [
    /["']?(?:authorization|cookie|set-cookie)["']?\s*:/i,
    /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /["']?\b(?:token|password|passwd|secret)\b["']?\s*[:=]\s*["'](?!\[(?:removed|redacted)\])[^"]{4,}["']/i,
];

const fail = (message) => {
    throw new Error(`cloud tracking validation failed: ${message}`);
};

const isRecord = (value) => value != null
    && typeof value === "object"
    && !Array.isArray(value);

const assertString = (value, label) => {
    if (typeof value !== "string" || value.trim() === "") {
        fail(`${label} must be a non-empty string`);
    }
    return value.trim();
};

const assertSafeScannerPath = (value) => {
    const scanner = assertString(value, "cloudTracking.scanner");
    const segments = scanner.split("/");
    if (scanner.includes("\\")
        || path.posix.isAbsolute(scanner)
        || path.win32.isAbsolute(scanner)
        || segments.some((segment) => segment === "" || segment === "." || segment === "..")
        || !scanner.toLowerCase().endsWith(".js")) {
        fail(`unsafe scanner path: ${scanner}`);
    }
    return scanner;
};

const pathInside = (root, candidate) => {
    const normalizedRoot = path.resolve(root);
    const normalizedCandidate = path.resolve(candidate);
    const rootWithSeparator = normalizedRoot.endsWith(path.sep)
        ? normalizedRoot
        : `${normalizedRoot}${path.sep}`;
    return normalizedCandidate === normalizedRoot
        || normalizedCandidate.startsWith(rootWithSeparator);
};

const resolveScannerPath = (root, scanner) => {
    const rootPath = path.resolve(root);
    const scannerPath = path.resolve(rootPath, ...scanner.split("/"));
    if (!pathInside(rootPath, scannerPath)) {
        fail(`scanner path escapes repository: ${scanner}`);
    }
    let rootRealPath;
    let scannerRealPath;
    try {
        rootRealPath = fs.realpathSync(rootPath);
        scannerRealPath = fs.realpathSync(scannerPath);
    } catch (error) {
        fail(`scanner file is missing: ${scanner}`);
    }
    if (!pathInside(rootRealPath, scannerRealPath)) {
        fail(`scanner symlink escapes repository: ${scanner}`);
    }
    let stat;
    try {
        stat = fs.statSync(scannerRealPath);
    } catch (error) {
        fail(`scanner file cannot be read: ${scanner}`);
    }
    if (!stat.isFile()) {
        fail(`scanner is not a regular file: ${scanner}`);
    }
    return scannerRealPath;
};

const loadScanner = (scannerPath, entry) => {
    let extension;
    try {
        delete require.cache[require.resolve(scannerPath)];
        extension = require(scannerPath);
    } catch (error) {
        fail(`scanner cannot be loaded for ${entry.key}/${entry.fileName}: ${error.message}`);
    }
    if (!isRecord(extension)) {
        fail(`scanner registration is not an object for ${entry.key}/${entry.fileName}`);
    }
    if (extension.extensionId !== `${entry.key}.scanning`
        || extension.artifactId !== entry.key
        || extension.sourceKey !== entry.key
        || extension.fileName !== entry.fileName
        || extension.apiVersion !== SCANNER_VERSION) {
        fail(`scanner identity mismatch for ${entry.key}/${entry.fileName}`);
    }
    const scanning = extension.capabilities && extension.capabilities.scanning;
    if (!isRecord(scanning)
        || scanning.version !== SCANNER_VERSION
        || typeof scanning.probeAccount !== "function"
        || typeof scanning.scanFavoriteSnapshotSlice !== "function") {
        fail(`scanner capability version or entry points mismatch for ${entry.key}/${entry.fileName}`);
    }
    return extension;
};

const validateEntry = (entry, root, seenPairs) => {
    if (!isRecord(entry)) {
        fail("every index entry must be an object");
    }
    const key = assertString(entry.key, "index entry key");
    const fileName = assertString(entry.fileName, `index entry ${key} fileName`);
    const identity = `${key}\u0000${fileName}`;
    if (seenPairs.has(identity)) {
        fail(`duplicate artifact identity: ${key}/${fileName}`);
    }
    seenPairs.add(identity);

    if (!Object.prototype.hasOwnProperty.call(entry, "cloudTracking")) {
        return null;
    }
    const capability = entry.cloudTracking;
    if (!isRecord(capability)) {
        fail(`cloudTracking must be an object for ${key}/${fileName}`);
    }
    const capabilityKeys = Object.keys(capability);
    if (capabilityKeys.length !== 1 || capabilityKeys[0] !== "scanner") {
        fail(`cloudTracking may contain only scanner for ${key}/${fileName}`);
    }
    const scanner = assertSafeScannerPath(capability.scanner);
    const scannerPath = resolveScannerPath(root, scanner);
    const extension = loadScanner(scannerPath, {key, fileName});
    return {key, fileName, scanner, extension};
};

const validateCloudTrackingCatalog = (catalog, {root = REPOSITORY_ROOT} = {}) => {
    if (!Array.isArray(catalog)) {
        fail("index.json must contain an array");
    }
    const seenPairs = new Set();
    const capabilities = [];
    for (const entry of catalog) {
        const capability = validateEntry(entry, root, seenPairs);
        if (capability) {
            capabilities.push(capability);
        }
    }
    return {entries: catalog, capabilities};
};

const validateScannerSecurity = (root, capabilities) => {
    for (const capability of capabilities) {
        const scannerPath = resolveScannerPath(root, capability.scanner);
        const source = fs.readFileSync(scannerPath, "utf8");
        for (const field of FORBIDDEN_SCANNER_FIELDS) {
            if (new RegExp(`\\b${field}\\b`).test(source)) {
                fail(`scanner uses forbidden legacy field ${field}: ${capability.key}/${capability.fileName}`);
            }
        }
    }
};

const validateFixtureSecurity = (root, relativeDirectory = "test/fixtures/manwa") => {
    const fixtureDirectory = path.resolve(root, ...relativeDirectory.split("/"));
    if (!pathInside(root, fixtureDirectory) || !fs.existsSync(fixtureDirectory)) {
        return;
    }
    for (const name of fs.readdirSync(fixtureDirectory).sort()) {
        const fixturePath = path.join(fixtureDirectory, name);
        const stat = fs.statSync(fixturePath);
        if (!stat.isFile()) {
            continue;
        }
        const source = fs.readFileSync(fixturePath, "utf8");
        for (const pattern of SENSITIVE_FIXTURE_PATTERNS) {
            if (pattern.test(source)) {
                fail(`fixture contains sensitive material: ${path.posix.join(relativeDirectory, name)}`);
            }
        }
    }
};

const validateCloudTrackingIndexFile = (indexPath, options = {}) => {
    const resolvedIndexPath = path.resolve(indexPath);
    let catalog;
    try {
        catalog = JSON.parse(fs.readFileSync(resolvedIndexPath, "utf8"));
    } catch (error) {
        fail(`index cannot be read: ${resolvedIndexPath}`);
    }
    const result = validateCloudTrackingCatalog(catalog, options);
    validateScannerSecurity(options.root || REPOSITORY_ROOT, result.capabilities);
    validateFixtureSecurity(options.root || REPOSITORY_ROOT);
    return result;
};

const parseArguments = (argv) => {
    let indexPath = null;
    let root = REPOSITORY_ROOT;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--root") {
            if (index + 1 >= argv.length) {
                fail("--root requires a path");
            }
            root = path.resolve(argv[++index]);
        } else if (argument.startsWith("--")) {
            fail(`unknown option: ${argument}`);
        } else if (indexPath == null) {
            indexPath = path.resolve(argument);
        } else {
            fail(`unexpected argument: ${argument}`);
        }
    }
    return {
        indexPath: indexPath || path.join(root, "index.json"),
        root,
    };
};

if (require.main === module) {
    try {
        const {indexPath, root} = parseArguments(process.argv.slice(2));
        const result = validateCloudTrackingIndexFile(indexPath, {root});
        process.stdout.write(
            `Cloud tracking catalog validated: ${result.entries.length} entries, `
            + `${result.capabilities.length} capable artifact(s).\n`,
        );
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    assertSafeScannerPath,
    validateCloudTrackingCatalog,
    validateCloudTrackingIndexFile,
    validateFixtureSecurity,
    validateScannerSecurity,
};
