#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to log colored output
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Function to check if a command exists
command_exists() {
    command -v "$1" &>/dev/null
}

# Function to install Node.js
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

# Function to install Rust
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

# Function to install Git
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

# Function to install buf (Protocol Buffer tool)
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

# Function to install Docker
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

# Function to install make
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
        if ! command_exists xcode-select; then
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

# Function to install Python3
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

# Function to install OpenAPI bundlers
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

# Function to install pandoc (for helm-spec command)
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

# Function to install helm-docs (for helm-spec command)
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

# Function to install crd-ref-docs (for crd-spec command)
install_crd_ref_docs() {
  if command_exists crd-ref-docs; then
    log_info "crd-ref-docs is already installed"
  else
    log_warn "crd-ref-docs is not installed. Required for: crd-spec command"
    log_info "Please install manually: https://github.com/elastic/crd-ref-docs"
  fi
}

# Function to install Go (for crd-spec command)
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

# Function to install curl and tar (for metrics-docs, rpk-docs)
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

# Function to check if expect and jq are installed and install them if they're not
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
# Function to check rpk installation and display its version
check_rpk_installed() {
    if command_exists rpk; then
        log_info "rpk is already installed. Version information:"
        rpk --version
        return 0
    else
        return 1
    fi
}

# Function to install rpk
install_rpk() {
    # Check if rpk is already installed
    if check_rpk_installed; then
        return 0
    fi

    log_info "Installing rpk..."
    
    # Determine OS and architecture
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    # Check if running on macOS and use Homebrew to install rpk
    if [ "${OS}" == "Darwin" ]; then
        log_info "Detected macOS. Attempting to install rpk using Homebrew..."

        # Check if Homebrew is installed
        if ! command_exists brew; then
            log_error "Homebrew not found. Please install Homebrew first: https://brew.sh"
            exit 1
        fi

        # Install rpk
        brew install redpanda-data/tap/redpanda || { log_error "Failed to install rpk via Homebrew"; exit 1; }

        # Verify installation
        log_info "rpk has been installed. Version information:"
        rpk --version
        return 0
    fi

    # For Linux systems
    if [ "${OS}" == "Linux" ]; then
        FILENAME="rpk-linux-amd64.zip"
        URL_BASE="https://github.com/redpanda-data/redpanda/releases"

        # Download latest version of rpk
        log_info "Downloading ${FILENAME}..."
        curl -Lf --retry 3 -O "${URL_BASE}/latest/download/${FILENAME}" \
            || { log_error "Failed to download rpk"; exit 1; }

        # Ensure the target directory exists
        mkdir -p $HOME/.local/bin || { log_error "Failed to create directory"; exit 1; }

        # Unzip the rpk binary to the target directory
        unzip -o "${FILENAME}" -d $HOME/.local/bin || { log_error "Failed to unzip rpk"; exit 1; }

        # Remove the downloaded archive
        rm "${FILENAME}" || { log_error "Failed to remove downloaded archive"; exit 1; }

        # Add the target directory to PATH for the current session
        export PATH=$HOME/.local/bin:$PATH

        # Add the target directory to PATH for future sessions
        echo 'export PATH=$HOME/.local/bin:$PATH' >> ~/.bashrc
        source ~/.bashrc

        # Verify installation
        log_info "rpk has been installed. Version information:"
        rpk --version
        return 0
    fi

    log_error "Unsupported operating system: ${OS}"
    log_error "Please install rpk manually: https://docs.redpanda.com/current/get-started/rpk-install/"
    exit 1
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
