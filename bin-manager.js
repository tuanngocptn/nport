import fs from "fs";
import path from "path";
import https from "https";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

// ============================================================================
// Configuration & Constants
// ============================================================================

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Binary configuration
const BIN_DIR = path.join(__dirname, "bin");
const BINARY_NAME = "cloudflared";
const COMPRESSED_SUFFIX = ".tgz";
const TEMP_ARCHIVE_NAME = "cloudflared.tgz";

// Platform detection
const PLATFORM = os.platform();
const ARCH = os.arch();
const IS_WINDOWS = PLATFORM === "win32";
const IS_MACOS = PLATFORM === "darwin";
const IS_LINUX = PLATFORM === "linux";

// Binary paths
const BIN_NAME = IS_WINDOWS ? `${BINARY_NAME}.exe` : BINARY_NAME;
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

// Download configuration
const GITHUB_BASE_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download";
const REDIRECT_CODES = [301, 302];
const SUCCESS_CODE = 200;
const UNIX_EXECUTABLE_MODE = "755";

// ============================================================================
// Platform Detection
// ============================================================================

/**
 * Platform and architecture mapping for cloudflared releases
 */
const PLATFORM_MAPPINGS = {
  darwin: {
    amd64: "cloudflared-darwin-amd64.tgz",
    arm64: "cloudflared-darwin-amd64.tgz", // macOS uses universal binary
  },
  win32: {
    x64: "cloudflared-windows-amd64.exe",
    ia32: "cloudflared-windows-386.exe",
  },
  linux: {
    x64: "cloudflared-linux-amd64",
    arm64: "cloudflared-linux-arm64",
    arm: "cloudflared-linux-arm",
  },
};

/**
 * Normalizes architecture name for mapping lookup
 * @param {string} arch - Raw architecture from os.arch()
 * @returns {string} Normalized architecture name
 */
function normalizeArch(arch) {
  const archMap = {
    x64: "x64",
    amd64: "amd64",
    arm64: "arm64",
    ia32: "ia32",
    arm: "arm",
  };
  return archMap[arch] || arch;
}

/**
 * Determines the download URL based on current platform and architecture
 * @returns {string} Download URL for cloudflared binary
 * @throws {Error} If platform/architecture combination is not supported
 */
function getDownloadUrl() {
  const normalizedArch = normalizeArch(ARCH);
  const platformMapping = PLATFORM_MAPPINGS[PLATFORM];

  if (!platformMapping) {
    throw new Error(
      `Unsupported platform: ${PLATFORM}. Supported platforms: darwin, win32, linux`
    );
  }

  const binaryName = platformMapping[normalizedArch];

  if (!binaryName) {
    throw new Error(
      `Unsupported architecture: ${ARCH} for platform ${PLATFORM}. ` +
        `Supported architectures: ${Object.keys(platformMapping).join(", ")}`
    );
  }

  return `${GITHUB_BASE_URL}/${binaryName}`;
}

/**
 * Checks if the download URL points to a compressed archive
 * @param {string} url - Download URL
 * @returns {boolean} True if URL is for a compressed file
 */
function isCompressedArchive(url) {
  return url.endsWith(COMPRESSED_SUFFIX);
}

// ============================================================================
// File System Utilities
// ============================================================================

/**
 * Ensures directory exists, creates it if it doesn't
 * @param {string} dirPath - Directory path to ensure
 */
function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Safely removes a file if it exists
 * @param {string} filePath - Path to file to remove
 */
function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    // Ignore errors during cleanup
    console.warn(`Warning: Could not remove ${filePath}:`, err.message);
  }
}

/**
 * Sets executable permissions on Unix-like systems
 * @param {string} filePath - Path to file
 * @param {string} mode - Permission mode (e.g., "755")
 */
function setExecutablePermissions(filePath, mode = UNIX_EXECUTABLE_MODE) {
  if (!IS_WINDOWS) {
    fs.chmodSync(filePath, mode);
  }
}

/**
 * Validates that a file exists at the given path
 * @param {string} filePath - Path to validate
 * @param {string} errorMessage - Error message if file doesn't exist
 * @throws {Error} If file doesn't exist
 */
function validateFileExists(filePath, errorMessage) {
  if (!fs.existsSync(filePath)) {
    throw new Error(errorMessage || `File not found: ${filePath}`);
  }
}

// ============================================================================
// Download Utilities
// ============================================================================

/**
 * Downloads a file from a URL with automatic redirect handling
 * @param {string} url - URL to download from
 * @param {string} dest - Destination file path
 * @returns {Promise<string>} Resolves with destination path on success
 */
async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https
      .get(url, (response) => {
        // Handle redirects
        if (REDIRECT_CODES.includes(response.statusCode)) {
          file.close();
          safeUnlink(dest);
          downloadFile(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
          return;
        }

        // Handle non-success status codes
        if (response.statusCode !== SUCCESS_CODE) {
          file.close();
          safeUnlink(dest);
          reject(
            new Error(
              `Download failed with status code ${response.statusCode} from ${url}`
            )
          );
          return;
        }

        // Stream response to file
        response.pipe(file);

        file.on("finish", () => {
          file.close(() => resolve(dest));
        });

        file.on("error", (err) => {
          file.close();
          safeUnlink(dest);
          reject(err);
        });
      })
      .on("error", (err) => {
        file.close();
        safeUnlink(dest);
        reject(new Error(`Network error: ${err.message}`));
      });
  });
}

// ============================================================================
// Archive Extraction
// ============================================================================

/**
 * Extracts a .tgz archive to a directory
 * @param {string} archivePath - Path to .tgz file
 * @param {string} targetDir - Directory to extract to
 * @throws {Error} If extraction fails
 */
function extractTarGz(archivePath, targetDir) {
  try {
    execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, {
      stdio: "pipe", // Suppress output
    });
  } catch (err) {
    throw new Error(`Extraction failed: ${err.message}`);
  }
}

// ============================================================================
// Logging Utilities
// ============================================================================

/**
 * Console logging with consistent formatting
 */
const logger = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.warn(`⚠️  ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  progress: (msg) => console.log(`🚧 ${msg}`),
  extract: (msg) => console.log(`📦 ${msg}`),
};

// ============================================================================
// Core Binary Management
// ============================================================================

/**
 * Downloads and installs the cloudflared binary
 * @returns {Promise<string>} Path to installed binary
 */
async function installBinary() {
  logger.progress(
    "Cloudflared binary not found. Downloading... (This happens only once)"
  );

  const url = getDownloadUrl();
  const isArchive = isCompressedArchive(url);
  const downloadDest = isArchive
    ? path.join(BIN_DIR, TEMP_ARCHIVE_NAME)
    : BIN_PATH;

  try {
    // Download binary or archive
    await downloadFile(url, downloadDest);

    // Extract if it's an archive (macOS)
    if (isArchive) {
      logger.extract("Extracting binary...");
      extractTarGz(downloadDest, BIN_DIR);

      // Clean up archive
      safeUnlink(downloadDest);

      // Validate extraction succeeded
      validateFileExists(
        BIN_PATH,
        "Extraction failed: Binary not found after extraction"
      );
    }

    // Set executable permissions (Unix-like systems)
    setExecutablePermissions(BIN_PATH);

    logger.success("Download complete.");
    return BIN_PATH;
  } catch (error) {
    // Clean up any partial downloads
    safeUnlink(downloadDest);
    safeUnlink(BIN_PATH);
    throw error;
  }
}

/**
 * Ensures cloudflared binary is available, downloading if necessary
 * @returns {Promise<string>} Path to cloudflared binary
 */
export async function ensureCloudflared() {
  // Ensure bin directory exists
  ensureDirectory(BIN_DIR);

  // Check if binary already exists
  if (fs.existsSync(BIN_PATH)) {
    // Always ensure permissions are set correctly (in case they were lost)
    setExecutablePermissions(BIN_PATH);
    return BIN_PATH;
  }

  // Download and install
  try {
    return await installBinary();
  } catch (error) {
    logger.error(`Installation failed: ${error.message}`);
    process.exit(1);
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

/**
 * Checks if we're running in a CI environment
 * @returns {boolean} True if in CI environment
 */
function isCI() {
  return !!(
    process.env.CI || // Generic CI flag
    process.env.GITHUB_ACTIONS || // GitHub Actions
    process.env.GITLAB_CI || // GitLab CI
    process.env.CIRCLECI || // CircleCI
    process.env.TRAVIS || // Travis CI
    process.env.JENKINS_URL || // Jenkins
    process.env.BUILDKITE // Buildkite
  );
}

/**
 * Main function when run directly from command line
 */
async function main() {
  // Skip binary download in CI environments to keep package lightweight
  if (isCI()) {
    logger.info("Running in CI environment - skipping binary download");
    return;
  }

  try {
    const binaryPath = await ensureCloudflared();
    logger.success(`Cloudflared binary is ready at: ${binaryPath}`);
  } catch (error) {
    logger.error(error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1] === __filename) {
  main();
}
