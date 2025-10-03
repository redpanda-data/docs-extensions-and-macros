#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# log_info prints a green "[INFO]"-prefixed message to stdout.
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
# log_warn prints a warning message prefixed with "[WARN]" in yellow to stdout.
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
# log_error echoes the provided message prefixed with a red `[ERROR]` tag.
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# command_exists checks whether the specified command is available on PATH.
command_exists() {
    command -v "$1" &>/dev/null
}

# install_node checks for Node.js and enforces a minimum version of 22.20.0; if Node.js is missing or below the required version it logs upgrade/install instructions and returns non-zero.
install_node() {
  local required_version="22.20.0"
  
  if command_exists node; then
    local current_version=$(node -v | sed 's/v//')
    log_info "Node.js is already installed. Version: v$current_version"
    
    # Check if current version meets minimum requirement
    if [ "$(printf '%s\n' "$required_version" "$current_version" | sort -V | head -n1)" = "$required_version" ]; then
      log_info "Node.js version meets minimum requirement (>= v$required_version)"
      return 0
    else
      log_warn "Node.js version v$current_version is below minimum required v$required_version"
      log_warn "Please upgrade Node.js manually to v$required_version or later"
      log_info "You can:"
      log_info "  1. Use fnm: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22 && fnm use 22"
      log_info "  2. Use nvm: nvm install 22 && nvm use 22"
      log_info "  3. Use Homebrew: brew install node@22"
      log_info "  4. Download from: https://nodejs.org/"
      log_warn "Some CLI features (like @redocly/cli 2.2.2) require Node.js >= v22.20.0"
      return 1
    fi
  else
    log_warn "Node.js is not installed"
    log_info "Please install Node.js v$required_version or later manually:"
    log_info "  1. Use fnm: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22 && fnm use 22"
    log_info "  2. Use nvm: nvm install 22 && nvm use 22"
    log_info "  3. Use Homebrew: brew install node@22"
    log_info "  4. Download from: https://nodejs.org/"
    return 1
  fi
}

# install_rust ensures the Rust toolchain is installed and configures the current shell environment.
install_rust() {
  if command_exists rustc; then
    log_info "Rust is already installed. Version: $(rustc --version)"
  else
    log_info "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y || { log_error "Failed to install Rust"; exit 1; }
    source $HOME/.cargo/env || { log_error "Failed to load Rust environment"; exit 1; }
    log_info "Rust version: $(rustc --version)"
  fi
}

# install_git installs Git if it is not present, using apt/yum on Linux or Homebrew on macOS. It logs the installed version on success and logs an error and exits with a non-zero status if the OS is unsupported or installation fails.
install_git() {
  if command_exists git; then
    log_info "Git is already installed. Version: $(git --version)"
  else
    log_info "Installing Git..."
    case "$(uname -s)" in
      Linux)
        sudo apt-get update && sudo apt-get install git -y || sudo yum install git -y || { log_error "Failed to install Git"; exit 1; }
        ;;
      Darwin)
        if command_exists brew; then
          brew install git || { log_error "Failed to install Git"; exit 1; }
        else
          log_error "Homebrew not found. Please install Git manually: https://git-scm.com/downloads"
          exit 1
        fi
        ;;
      *)
        log_error "Unsupported OS. Please install Git manually: https://git-scm.com/downloads"
        exit 1
        ;;
    esac
    log_info "Git installed. Version: $(git --version)"
  fi
}

# install_buf installs the buf Protocol Buffer CLI tool when it is not already available.
# On Linux it places a released buf binary into /usr/local/bin; on macOS it uses Homebrew if present.
install_buf() {
  if command_exists buf; then
    log_info "buf is already installed. Version: $(buf --version)"
  else
    log_info "Installing buf..."
    case "$(uname -s)" in
      Linux)
        # Download and install buf for Linux
        BIN="/usr/local/bin/buf"
        VERSION="1.28.1"
        curl -sSL "https://github.com/bufbuild/buf/releases/download/v${VERSION}/buf-$(uname -s)-$(uname -m)" -o "${BIN}" || { log_error "Failed to download buf"; exit 1; }
        chmod +x "${BIN}" || { log_error "Failed to make buf executable"; exit 1; }
        ;;
      Darwin)
        if command_exists brew; then
          brew install bufbuild/buf/buf || { log_error "Failed to install buf"; exit 1; }
        else
          log_error "Homebrew not found. Please install buf manually: https://buf.build/docs/installation"
          exit 1
        fi
        ;;
      *)
        log_error "Unsupported OS. Please install buf manually: https://buf.build/docs/installation"
        exit 1
        ;;
    esac
    log_info "buf installed. Version: $(buf --version)"
  fi
}

# install_docker checks whether Docker is installed; logs the installed version and warns if the Docker daemon is not running. If Docker is not found, logs the manual installation URL and notes that Docker is required for the metrics-docs and rpk-docs commands.
install_docker() {
  if command_exists docker; then
    log_info "Docker is already installed. Version: $(docker --version)"
    # Check if Docker daemon is running
    if ! docker info &>/dev/null; then
      log_warn "Docker is installed but daemon is not running. Please start Docker."
    fi
  else
    log_warn "Docker is not installed. Please install Docker manually: https://docs.docker.com/get-docker/"
    log_warn "Docker is required for: metrics-docs, rpk-docs commands"
  fi
}

# install_make ensures `make` is available, installing build-essential (or Development Tools) on Linux or the Xcode Command Line Tools on macOS, and exits with an error for unsupported OS or failed installation.
install_make() {
  if command_exists make; then
    log_info "make is already installed. Version: $(make --version | head -1)"
  else
    log_info "Installing make..."
    case "$(uname -s)" in
      Linux)
        sudo apt-get update && sudo apt-get install build-essential -y || sudo yum groupinstall "Development Tools" -y || { log_error "Failed to install make"; exit 1; }
        ;;
      Darwin)
        if ! xcode-select -p &>/dev/null; then
          xcode-select --install || { log_error "Failed to install Xcode Command Line Tools"; exit 1; }
        fi
        ;;
      *)
        log_error "Unsupported OS. Please install make manually."
        exit 1
        ;;
    esac
    log_info "make installed successfully"
  fi
}

# install_python ensures Python3 and pip are available. It logs an existing python/python3 version if present; otherwise installs `python3` and `python3-pip` on Linux (apt-get or yum) or via Homebrew on macOS, and exits with an error for unsupported systems or failed installations.
install_python() {
  if command_exists python3; then
    log_info "Python3 is already installed. Version: $(python3 --version)"
  elif command_exists python; then
    log_info "Python is already installed. Version: $(python --version)"
  else
    log_info "Installing Python3..."
    case "$(uname -s)" in
      Linux)
        sudo apt-get update && sudo apt-get install python3 python3-pip -y || sudo yum install python3 python3-pip -y || { log_error "Failed to install Python3"; exit 1; }
        ;;
      Darwin)
        if command_exists brew; then
          brew install python || { log_error "Failed to install Python3"; exit 1; }
        else
          log_error "Homebrew not found. Please install Python3 manually: https://python.org"
          exit 1
        fi
        ;;
      *)
        log_error "Unsupported OS. Please install Python3 manually: https://python.org"
        exit 1
        ;;
    esac
    log_info "Python3 installed successfully"
  fi
}

# install_openapi_bundlers ensures an OpenAPI bundler (Redocly CLI or swagger-cli) is available by installing `@redocly/cli` globally and falling back to `swagger-cli` if needed. It exits with a non-zero status if neither bundler can be installed.
install_openapi_bundlers() {
  local bundler_found=false
  
  # Check for swagger-cli
  if command_exists swagger-cli; then
    log_info "swagger-cli is already installed"
    bundler_found=true
  fi
  
  # Check for redocly
  if command_exists redocly; then
    log_info "redocly is already installed"
    bundler_found=true
  fi
  
  # Check for @redocly/cli via npx
  if npx @redocly/cli --version &>/dev/null; then
    log_info "@redocly/cli is available via npx"
    bundler_found=true
  fi
  
  if ! $bundler_found; then
    log_info "Installing @redocly/cli..."
    npm install -g @redocly/cli || { 
      log_warn "Failed to install @redocly/cli globally. Installing swagger-cli as fallback..."
      npm install -g swagger-cli || { 
        log_error "Failed to install OpenAPI bundler. Please install manually:
  npm install -g @redocly/cli
  or
  npm install -g swagger-cli"
        exit 1
      }
    }
  fi
}

# install_pandoc ensures pandoc is available on the system, installing it via apt/yum on Linux or Homebrew on macOS, and exits with an error message on failure.
install_pandoc() {
  if command_exists pandoc; then
    log_info "pandoc is already installed. Version: $(pandoc --version | head -1)"
  else
    log_info "Installing pandoc..."
    case "$(uname -s)" in
      Linux)
        sudo apt-get update && sudo apt-get install pandoc -y || sudo yum install pandoc -y || { log_error "Failed to install pandoc"; exit 1; }
        ;;
      Darwin)
        if command_exists brew; then
          brew install pandoc || { log_error "Failed to install pandoc"; exit 1; }
        else
          log_error "Homebrew not found. Please install pandoc manually: https://pandoc.org"
          exit 1
        fi
        ;;
      *)
        log_error "Unsupported OS. Please install pandoc manually: https://pandoc.org"
        exit 1
        ;;
    esac
    log_info "pandoc installed successfully"
  fi
}

# install_helm_docs checks for helm-docs and, if missing, logs installation instructions and macOS/Homebrew guidance for the helm-spec command.
install_helm_docs() {
  if command_exists helm-docs; then
    log_info "helm-docs is already installed. Version: $(helm-docs --version)"
  else
    log_warn "helm-docs is not installed. Required for: helm-spec command"
    log_info "Please install manually: https://github.com/norwoodj/helm-docs"
    case "$(uname -s)" in
      Darwin)
        if command_exists brew; then
          log_info "You can install with: brew install norwoodj/tap/helm-docs"
        fi
        ;;
    esac
  fi
}

# install_crd_ref_docs checks for the `crd-ref-docs` tool and logs whether it is installed or provides a manual install URL required by the `crd-spec` command.
install_crd_ref_docs() {
  if command_exists crd-ref-docs; then
    log_info "crd-ref-docs is already installed"
  else
    log_warn "crd-ref-docs is not installed. Required for: crd-spec command"
    log_info "Please install manually: https://github.com/elastic/crd-ref-docs"
  fi
}

# install_go checks whether Go is installed and logs its version; if missing, it logs OS-specific installation guidance and a download URL for use by the crd-spec command.
install_go() {
  if command_exists go; then
    log_info "Go is already installed. Version: $(go version)"
  else
    log_warn "Go is not installed. Required for: crd-spec command"
    case "$(uname -s)" in
      Linux)
        log_info "You can install with: sudo apt install golang-go (Ubuntu/Debian) or sudo yum install golang (RHEL/CentOS)"
        ;;
      Darwin)
        if command_exists brew; then
          log_info "You can install with: brew install go"
        fi
        ;;
    esac
    log_info "Or download from: https://golang.org/dl/"
  fi
}

# install_basic_tools ensures `curl` and `tar` are present; installs them on Linux using `apt-get` or `yum`, and on macOS uses Homebrew for `curl` (noting that `tar` is typically preinstalled). Exits with a non-zero status if an attempted automatic installation fails.
install_basic_tools() {
  if ! command_exists curl; then
    log_info "Installing curl..."
    case "$(uname -s)" in
      Linux)
        sudo apt-get update && sudo apt-get install curl -y || sudo yum install curl -y || { log_error "Failed to install curl"; exit 1; }
        ;;
      Darwin)
        if command_exists brew; then
          brew install curl || { log_error "Failed to install curl"; exit 1; }
        fi
        ;;
    esac
  else
    log_info "curl is already installed"
  fi
  
  if ! command_exists tar; then
    log_info "Installing tar..."
    case "$(uname -s)" in
      Linux)
        sudo apt-get update && sudo apt-get install tar -y || sudo yum install tar -y || { log_error "Failed to install tar"; exit 1; }
        ;;
      Darwin)
        log_info "tar is typically pre-installed on macOS"
        ;;
    esac
  else
    log_info "tar is already installed"
  fi
}

# ensure_dependencies_installed checks for `expect` and `jq`, installs them if missing, and orchestrates verification and installation of core and optional tooling required by the doc-tools CLI.
# It runs installers for Node.js, Rust, Git, buf, Docker, make, Python, basic tools, OpenAPI bundlers, pandoc, and optional helpers (helm-docs, crd-ref-docs, Go), and will emit a warning if the Node.js version requirement is not met.
ensure_dependencies_installed() {
    if ! command_exists expect; then
        log_info "Installing expect..."
        case "$(uname -s)" in
            Linux)
                sudo apt-get update && sudo apt-get install expect -y || sudo yum install expect -y || { log_error "Failed to install expect"; exit 1; }
                ;;
            Darwin)
                if ! command_exists brew; then
                    log_error "Homebrew not found."
                    exit 1
                fi
                brew install expect || { log_error "Failed to install expect"; exit 1; }
                ;;
            *)
                log_error "Unsupported operating system. Please install expect manually."
                exit 1
                ;;
        esac
    else
        log_info "expect is already installed"
    fi

    if ! command_exists jq; then
        log_info "Installing jq..."
        case "$(uname -s)" in
            Linux)
                sudo apt-get update && sudo apt-get install jq -y || sudo yum install jq -y || { log_error "Failed to install jq"; exit 1; }
                ;;
            Darwin)
                if command_exists brew; then
                    brew install jq || { log_error "Failed to install jq"; exit 1; }
                else
                    log_error "Homebrew not found."
                    exit 1
                fi
                ;;
            *)
                log_error "Unsupported operating system. Please install jq manually."
                exit 1
                ;;
        esac
    else
        log_info "jq is already installed"
    fi

    # Install core dependencies
    local node_ok=true
    install_node || node_ok=false
    install_rust
    install_git
    install_buf
    install_docker
    install_make
    install_python
    install_basic_tools
    install_openapi_bundlers
    install_pandoc
    
    # Optional dependencies (warn if missing)
    install_helm_docs
    install_crd_ref_docs
    install_go
    
    if [ "$node_ok" = false ]; then
        log_warn "⚠️  Node.js version requirement not met. Some CLI features may not work properly."
    fi
}

# Ensure all dependencies are installed
log_info "Installing/checking dependencies for doc-tools CLI commands..."
ensure_dependencies_installed

# install_rpk installs Redpanda's rpk CLI into ~/.local/bin by downloading the appropriate release for the current OS and architecture, adding it to PATH for the current and future sessions, and verifying the installation; returns 0 on success and non-zero on failure.
install_rpk() {
    if command_exists rpk; then
        log_info "rpk is already installed. Version information:"
        rpk --version
        return 0
    fi
    
    log_info "Installing rpk..."
    
    # Detect OS and architecture
    local os_name=$(uname -s)
    local arch_name=$(uname -m)
    
    # Map OS name to rpk release format
    local rpk_os=""
    case "$os_name" in
        "Darwin")
            rpk_os="darwin"
            ;;
        "Linux")
            rpk_os="linux"
            ;;
        *)
            log_warn "Unsupported operating system: $os_name"
            log_warn "Please install rpk manually:"
            log_warn "https://docs.redpanda.com/current/get-started/rpk-install/"
            return 1
            ;;
    esac
    
    # Map architecture to rpk release format
    local rpk_arch=""
    case "$arch_name" in
        "x86_64" | "amd64")
            rpk_arch="amd64"
            ;;
        "arm64" | "aarch64")
            rpk_arch="arm64"
            ;;
        *)
            log_warn "Unsupported architecture: $arch_name"
            log_warn "Please install rpk manually:"
            log_warn "https://docs.redpanda.com/current/get-started/rpk-install/"
            return 1
            ;;
    esac
    
    # Construct download URL and filename
    local rpk_filename="rpk-${rpk_os}-${rpk_arch}.zip"
    local rpk_url="https://github.com/redpanda-data/redpanda/releases/latest/download/${rpk_filename}"
    
    log_info "Detected ${os_name} ${arch_name}, downloading ${rpk_filename}..."
    
    # Try to download and install rpk
    if curl -LO "$rpk_url"; then
        if unzip "$rpk_filename" 2>/dev/null; then
            mkdir -p ~/.local/bin
            if mv rpk ~/.local/bin/ 2>/dev/null; then
                rm "$rpk_filename"
                
                # Add to PATH for current session
                export PATH=$HOME/.local/bin:$PATH
                
                # Add the target directory to PATH for future sessions
                if ! grep -q 'export PATH=$HOME/.local/bin:$PATH' ~/.bashrc 2>/dev/null; then
                    echo 'export PATH=$HOME/.local/bin:$PATH' >> ~/.bashrc
                fi
                
                # Verify installation
                if command_exists rpk; then
                    log_info "rpk has been installed successfully. Version information:"
                    rpk --version
                    return 0
                else
                    log_warn "rpk installation may have failed. Please install manually:"
                    log_warn "https://docs.redpanda.com/current/get-started/rpk-install/"
                    return 1
                fi
            else
                log_warn "Failed to move rpk binary to ~/.local/bin/"
                rm -f "$rpk_filename" rpk 2>/dev/null
                log_warn "Please install rpk manually:"
                log_warn "https://docs.redpanda.com/current/get-started/rpk-install/"
                return 1
            fi
        else
            log_warn "Failed to unzip $rpk_filename (may not exist for ${rpk_os}-${rpk_arch})"
            rm -f "$rpk_filename" 2>/dev/null
            log_warn "Please install rpk manually:"
            log_warn "https://docs.redpanda.com/current/get-started/rpk-install/"
            return 1
        fi
    else
        log_warn "Failed to download $rpk_url"
        log_warn "Please install rpk manually:"
        log_warn "https://docs.redpanda.com/current/get-started/rpk-install/"
        return 1
    fi
}

# Install rpk for rpcn-connector-docs command
install_rpk

log_info "✅ All dependencies installation/check completed!"
log_info ""
log_info "📋 Summary of installed tools:"
log_info "Core tools: Node.js (>= v22.20.0), Git, buf, curl, tar, jq, expect"
log_info "OpenAPI bundlers: @redocly/cli or swagger-cli"  
log_info "Build tools: make, Python3"
log_info "Optional tools: Docker, pandoc, helm-docs, crd-ref-docs, Go, rpk"
log_info ""
log_info "🚀 You can now use all doc-tools CLI commands!"
log_info "📚 Run 'doc-tools --help' to see available commands"
