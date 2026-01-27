import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

const BIN_DIR = path.join(__dirname, 'bin');
const BINARY_NAME = 'cloudflared';
const COMPRESSED_SUFFIX = '.tgz';
const TEMP_ARCHIVE_NAME = 'cloudflared.tgz';

const PLATFORM = os.platform();
const ARCH = os.arch();
const IS_WINDOWS = PLATFORM === 'win32';

const BIN_NAME = IS_WINDOWS ? `${BINARY_NAME}.exe` : BINARY_NAME;
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

const GITHUB_BASE_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const REDIRECT_CODES = [301, 302];
const SUCCESS_CODE = 200;
const UNIX_EXECUTABLE_MODE = '755';

type PlatformMappings = Record<string, Record<string, string>>;

const PLATFORM_MAPPINGS: PlatformMappings = {
  darwin: {
    amd64: 'cloudflared-darwin-amd64.tgz',
    arm64: 'cloudflared-darwin-amd64.tgz',
    x64: 'cloudflared-darwin-amd64.tgz',
  },
  win32: {
    x64: 'cloudflared-windows-amd64.exe',
    ia32: 'cloudflared-windows-386.exe',
  },
  linux: {
    x64: 'cloudflared-linux-amd64',
    arm64: 'cloudflared-linux-arm64',
    arm: 'cloudflared-linux-arm',
  },
};

function normalizeArch(arch: string): string {
  const archMap: Record<string, string> = {
    x64: 'x64',
    amd64: 'amd64',
    arm64: 'arm64',
    ia32: 'ia32',
    arm: 'arm',
  };
  return archMap[arch] || arch;
}

function getDownloadUrl(): string {
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
        `Supported architectures: ${Object.keys(platformMapping).join(', ')}`
    );
  }

  return `${GITHUB_BASE_URL}/${binaryName}`;
}

function isCompressedArchive(url: string): boolean {
  return url.endsWith(COMPRESSED_SUFFIX);
}

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore
  }
}

function setExecutablePermissions(filePath: string, mode: string = UNIX_EXECUTABLE_MODE): void {
  if (!IS_WINDOWS) {
    fs.chmodSync(filePath, mode);
  }
}

function validateFileExists(filePath: string, errorMessage: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(errorMessage || `File not found: ${filePath}`);
  }
}

async function downloadFile(url: string, dest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https
      .get(url, (response) => {
        if (REDIRECT_CODES.includes(response.statusCode!)) {
          file.close();
          safeUnlink(dest);
          downloadFile(response.headers.location!, dest)
            .then(resolve)
            .catch(reject);
          return;
        }

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

        response.pipe(file);

        file.on('finish', () => {
          file.close(() => resolve(dest));
        });

        file.on('error', (err) => {
          file.close();
          safeUnlink(dest);
          reject(err);
        });
      })
      .on('error', (err) => {
        file.close();
        safeUnlink(dest);
        reject(new Error(`Network error: ${err.message}`));
      });
  });
}

function extractTarGz(archivePath: string, targetDir: string): void {
  try {
    execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, {
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`Extraction failed: ${(err as Error).message}`);
  }
}

const logger = {
  info: (msg: string) => console.log(`ℹ️  ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  warn: (msg: string) => console.warn(`⚠️  ${msg}`),
  error: (msg: string) => console.error(`❌ ${msg}`),
  progress: (msg: string) => console.log(`🚧 ${msg}`),
  extract: (msg: string) => console.log(`📦 ${msg}`),
};

async function installBinary(): Promise<string> {
  logger.progress(
    'Cloudflared binary not found. Downloading... (This happens only once)'
  );

  const url = getDownloadUrl();
  const isArchive = isCompressedArchive(url);
  const downloadDest = isArchive
    ? path.join(BIN_DIR, TEMP_ARCHIVE_NAME)
    : BIN_PATH;

  try {
    await downloadFile(url, downloadDest);

    if (isArchive) {
      logger.extract('Extracting binary...');
      extractTarGz(downloadDest, BIN_DIR);
      safeUnlink(downloadDest);
      validateFileExists(
        BIN_PATH,
        'Extraction failed: Binary not found after extraction'
      );
    }

    setExecutablePermissions(BIN_PATH);

    logger.success('Download complete.');
    return BIN_PATH;
  } catch (error) {
    safeUnlink(downloadDest);
    safeUnlink(BIN_PATH);
    throw error;
  }
}

export async function ensureCloudflared(): Promise<string> {
  ensureDirectory(BIN_DIR);

  if (fs.existsSync(BIN_PATH)) {
    setExecutablePermissions(BIN_PATH);
    return BIN_PATH;
  }

  try {
    return await installBinary();
  } catch (error) {
    logger.error(`Installation failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS ||
    process.env.JENKINS_URL ||
    process.env.BUILDKITE
  );
}

async function main(): Promise<void> {
  if (isCI()) {
    logger.info('Running in CI environment - skipping binary download');
    return;
  }

  try {
    const binaryPath = await ensureCloudflared();
    logger.success(`Cloudflared binary is ready at: ${binaryPath}`);
  } catch (error) {
    logger.error((error as Error).message);
    process.exit(1);
  }
}

// Run if executed directly
const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFilePath || process.argv[1]?.endsWith('bin-manager.js')) {
  main();
}
