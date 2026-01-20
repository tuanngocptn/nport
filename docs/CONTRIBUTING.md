# Contributing to NPort

> Thank you for your interest in contributing to NPort! 🎉

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Guidelines](#coding-guidelines)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Adding Translations](#adding-translations)
- [Reporting Issues](#reporting-issues)

---

## Code of Conduct

By participating in this project, you agree to be respectful and inclusive. We welcome contributors of all backgrounds and experience levels.

---

## Getting Started

### Prerequisites

- **Node.js** >= 20.0.0
- **npm** >= 10.0.0
- **Git**

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/nport.git
   cd nport
   ```

3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/tuanngocptn/nport.git
   ```

---

## Development Setup

### CLI Development

```bash
# Install dependencies
npm install

# Run locally (instead of globally installed version)
node index.js 3000 -s test

# Or link globally for testing
npm link
nport 3000 -s test
```

### Server Development (Cloudflare Worker)

```bash
cd server

# Install dependencies
npm install

# Run local development server
npm run dev

# Run tests
npm test
```

### Website Development

```bash
cd website

# Install dependencies
npm install

# Start local server (use any static server)
npx serve .
```

---

## Project Structure

```
nport/
├── index.js              # CLI entry point
├── src/                  # CLI source code
│   ├── analytics.js      # Usage analytics
│   ├── api.js            # Backend API client
│   ├── args.js           # Argument parsing
│   ├── binary.js         # cloudflared process management
│   ├── bin-manager.js    # Binary download/installation
│   ├── config.js         # Constants and configuration
│   ├── config-manager.js # Persistent user config
│   ├── lang.js           # i18n translations
│   ├── state.js          # Application state
│   ├── tunnel.js         # Main tunnel orchestration
│   ├── ui.js             # Console UI components
│   └── version.js        # Version checking
├── server/               # Backend (Cloudflare Worker)
│   ├── src/index.js      # Worker entry point
│   └── test/             # Worker tests
├── website/              # Static landing page
├── docs/                 # Documentation
└── bin/                  # cloudflared binary (auto-downloaded)
```

---

## Coding Guidelines

### General Principles

- **Keep it simple**: Prefer clear, readable code over clever solutions
- **Single responsibility**: Each module should do one thing well
- **Fail gracefully**: Handle errors without crashing the CLI
- **User experience first**: CLI output should be helpful and pretty

### JavaScript Style

- Use **ES Modules** (`import`/`export`)
- Use **async/await** for asynchronous code
- Use **camelCase** for variables and functions
- Use **PascalCase** for classes
- Use **UPPER_SNAKE_CASE** for constants

### Code Example

```javascript
import chalk from "chalk";

/**
 * Validates a subdomain string
 * @param {string} subdomain - The subdomain to validate
 * @returns {boolean} True if valid, false otherwise
 */
export function validateSubdomain(subdomain) {
  if (!subdomain || typeof subdomain !== "string") {
    return false;
  }
  
  // Subdomain rules: alphanumeric and hyphens, 3-63 chars
  const pattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/i;
  return pattern.test(subdomain);
}
```

### JSDoc Comments

Add JSDoc comments to all public functions:

```javascript
/**
 * Brief description of what the function does
 * @param {Type} paramName - Description of parameter
 * @returns {ReturnType} Description of return value
 * @throws {Error} When and why it throws
 */
```

### Console Output

- Use `chalk` for colors
- Use `ora` for spinners
- Support i18n via `lang.t()`
- Keep messages user-friendly

```javascript
// Good
console.log(chalk.green(`✔ ${lang.t("tunnelCreated")}`));

// Avoid
console.log("tunnel created");
```

---

## Making Changes

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation changes
- `refactor/description` - Code refactoring

### Commit Messages

Follow conventional commits:

```
type(scope): brief description

[optional body]

[optional footer]
```

Examples:
```
feat(cli): add --timeout flag for custom tunnel duration
fix(api): handle network timeout gracefully
docs(readme): add troubleshooting section
refactor(binary): extract download logic to separate function
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

---

## Testing

### CLI Testing (Manual)

```bash
# Test basic tunnel creation
node index.js 3000

# Test with custom subdomain
node index.js 3000 -s mytest

# Test version flag
node index.js -v

# Test language selection
node index.js -l
```

### Server Testing

```bash
cd server
npm test
```

### Adding Tests

When adding new features, include tests:

```javascript
// server/test/feature.spec.js
import { describe, it, expect } from "vitest";

describe("Feature Name", () => {
  it("should do something", () => {
    expect(true).toBe(true);
  });
});
```

---

## Submitting a Pull Request

1. **Update your fork**:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Create a feature branch**:
   ```bash
   git checkout -b feature/my-feature
   ```

3. **Make your changes** and commit:
   ```bash
   git add .
   git commit -m "feat: add my feature"
   ```

4. **Push to your fork**:
   ```bash
   git push origin feature/my-feature
   ```

5. **Open a Pull Request** on GitHub

### PR Checklist

- [ ] Code follows project style guidelines
- [ ] Self-reviewed my code
- [ ] Added JSDoc comments to new functions
- [ ] Updated documentation if needed
- [ ] Tested changes locally
- [ ] No console errors or warnings

---

## Adding Translations

NPort supports multiple languages. To add a new language:

### 1. Edit `src/lang.js`

Add your language code to `availableLanguages`:

```javascript
this.availableLanguages = ["en", "vi", "es"]; // Add your code
```

### 2. Add Translations

Add a new object in `TRANSLATIONS`:

```javascript
const TRANSLATIONS = {
  en: { /* ... */ },
  vi: { /* ... */ },
  es: {  // Your new language
    header: "N P O R T  ⚡️  Gratis y de código abierto",
    creatingTunnel: "Creando túnel para el puerto {port}...",
    tunnelLive: "🚀 ¡ESTAMOS EN VIVO!",
    // ... translate all keys
  },
};
```

### 3. Update Language Selection

Update the prompts in both `en` and your language:

```javascript
en: {
  languageSpanish: "3. Español (Spanish)",
},
es: {
  languageSpanish: "3. Español",
},
```

### 4. Test Your Translation

```bash
node index.js -l es
node index.js 3000
```

---

## Reporting Issues

### Before Submitting

1. Check [existing issues](https://github.com/tuanngocptn/nport/issues)
2. Try the latest version: `npm install -g nport@latest`
3. Gather system info: Node version, OS, error messages

### Issue Template

```markdown
## Description
Brief description of the issue

## Steps to Reproduce
1. Run `nport 3000 -s test`
2. ...
3. See error

## Expected Behavior
What you expected to happen

## Actual Behavior
What actually happened

## Environment
- NPort version: `nport -v`
- Node version: `node -v`
- OS: macOS 14.0 / Ubuntu 22.04 / Windows 11

## Logs
```
Paste any error messages here
```
```

---

## Questions?

- 📧 Email: tuanngocptn@gmail.com
- 🐛 Issues: [GitHub Issues](https://github.com/tuanngocptn/nport/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/tuanngocptn/nport/discussions)

---

Made with ❤️ in Vietnam by [Nick Pham](https://github.com/tuanngocptn)
