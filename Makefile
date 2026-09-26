# =============================================================================
# Opaque Stellar — root task runner
# =============================================================================
# One command runs all main CI checks locally: make ci
#
# Network-touching targets are explicit and clearly labelled so they are never
# run accidentally (smoke:testnet, deploy:testnet, deploy:mainnet).
#
# Usage:
#   make <target>          run a single target
#   make ci                run all offline CI checks in sequence
#   make help              list all targets with descriptions
#
# Prerequisites: Rust (stable), wasm-pack, Stellar CLI, Node 20/22.
# See docs/LOCAL_DEVELOPMENT.md for the full setup guide.
# =============================================================================

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

.PHONY: help
help: ## Show this help message
	@echo "Opaque Stellar — available make targets"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-28s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo "  Run all offline CI checks at once: make ci"

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

.PHONY: install
install: ## Install all Node workspace dependencies (npm ci in every workspace)
	npm ci
	npm ci --prefix frontend
	npm ci --prefix sdk
	npm ci --prefix relayer
	npm ci --prefix asp
	@echo "All Node dependencies installed."

# ---------------------------------------------------------------------------
# Build targets
# ---------------------------------------------------------------------------

.PHONY: build-contracts
build-contracts: ## Build all Soroban contracts to release WASM
	stellar contract build

.PHONY: build-scanner
build-scanner: ## Compile the scanner Rust crate to WASM via wasm-pack
	npm run build:scanner

.PHONY: build-frontend
build-frontend: ## Production build of the React frontend (runs prebuild/prepare step)
	npm run build --prefix frontend

.PHONY: build-sdk
build-sdk: ## Build the @opaquecash/stellar TypeScript SDK
	npm run build --prefix sdk

.PHONY: fetch-circuits
fetch-circuits: ## Download pinned circuit artifacts (zkey, witness WASM) from GitHub release
	@echo "NOTE: requires network access to GitHub releases."
	npm run fetch:circuits

# ---------------------------------------------------------------------------
# Test targets
# ---------------------------------------------------------------------------

.PHONY: test-contracts
test-contracts: ## Run Rust unit and property tests for all contracts
	cargo test --workspace --locked

.PHONY: test-frontend
test-frontend: ## Run frontend unit tests (vitest --run)
	npm test --prefix frontend

.PHONY: test-sdk
test-sdk: ## Run SDK unit tests (vitest --run)
	npm test --prefix sdk

.PHONY: test-relayer
test-relayer: ## Run relayer service tests
	npm test --prefix relayer

.PHONY: test-asp
test-asp: ## Run ASP service tests
	npm test --prefix asp

.PHONY: test-publisher
test-publisher: ## Run publisher service tests
	npm test --prefix publisher

.PHONY: test-circuits
test-circuits: ## Run Circom regression fixture tests (requires circom toolchain)
	npm run test:circuits

.PHONY: test
test: test-contracts test-frontend test-sdk test-relayer test-asp test-publisher ## Run all offline unit tests

# ---------------------------------------------------------------------------
# Lint / format targets
# ---------------------------------------------------------------------------

.PHONY: fmt
fmt: ## Check Rust formatting (cargo fmt --check)
	cargo fmt --all -- --check

.PHONY: fmt-fix
fmt-fix: ## Auto-fix Rust formatting
	cargo fmt --all

.PHONY: lint-contracts
lint-contracts: ## Run Clippy on all contracts (warnings are errors)
	cargo clippy --workspace --all-targets -- -D warnings

.PHONY: lint-frontend
lint-frontend: ## Run ESLint on the frontend
	npm run lint --prefix frontend

.PHONY: lint-sdk
lint-sdk: ## Run ESLint on the SDK
	npm run lint --prefix sdk

.PHONY: lint
lint: fmt lint-contracts lint-frontend lint-sdk ## Run all linters

# ---------------------------------------------------------------------------
# Type-check targets
# ---------------------------------------------------------------------------

.PHONY: typecheck-frontend
typecheck-frontend: ## TypeScript type-check the frontend
	npx tsc -b --noEmit --prefix frontend

.PHONY: typecheck-sdk
typecheck-sdk: ## TypeScript type-check the SDK
	npm run typecheck --prefix sdk

.PHONY: typecheck-relayer
typecheck-relayer: ## TypeScript type-check the relayer service
	npm run typecheck --prefix relayer

.PHONY: typecheck-asp
typecheck-asp: ## TypeScript type-check the ASP service
	npm run typecheck --prefix asp

.PHONY: typecheck-publisher
typecheck-publisher: ## TypeScript type-check the publisher service
	npm run typecheck --prefix publisher

.PHONY: typecheck
typecheck: typecheck-sdk typecheck-relayer typecheck-asp typecheck-publisher ## Run all TypeScript type-checks

# ---------------------------------------------------------------------------
# Verification / manifest targets
# ---------------------------------------------------------------------------

.PHONY: verify-deployment
verify-deployment: ## Verify the deployment manifest schema and contract addresses
	npm run verify:deployment

.PHONY: verify-artifacts
verify-artifacts: ## Verify pinned WASM and circuit artifact hashes against manifest.json
	npm run verify:artifacts

.PHONY: audit
audit: ## Run cargo audit + cargo deny + npm audit (supply chain)
	cargo audit
	cargo deny check
	npm audit --omit=dev
	npm audit --omit=dev --prefix frontend

# ---------------------------------------------------------------------------
# License / notices targets
# ---------------------------------------------------------------------------

.PHONY: notices-generate
notices-generate: ## Regenerate THIRD_PARTY_NOTICES.md from current dependencies
	npm run notices:generate

.PHONY: notices-verify
notices-verify: ## Verify THIRD_PARTY_NOTICES.md is current (runs in CI)
	npm run notices:verify

# ---------------------------------------------------------------------------
# Artifact hashing
# ---------------------------------------------------------------------------

.PHONY: hash-artifacts
hash-artifacts: ## Recompute and update artifact hashes in manifest.json after a rebuild
	npm run update:artifacts

# ---------------------------------------------------------------------------
# Smoke / testnet targets  (require network access — never run in offline CI)
# ---------------------------------------------------------------------------

.PHONY: smoke-testnet
smoke-testnet: ## [NETWORK] Smoke-test against live testnet: verify deployment + artifact manifests
	@echo "NOTE: connects to Stellar testnet."
	npm run verify:deployment
	npm run verify:artifacts

.PHONY: deploy-testnet
deploy-testnet: ## [NETWORK] Build and deploy all contracts to testnet (requires .env)
	@echo "NOTE: broadcasts transactions to Stellar testnet."
	npm run deploy:testnet

.PHONY: deploy-mainnet
deploy-mainnet: ## [NETWORK] Deploy to mainnet — requires audit signoff gate
	@echo "NOTE: broadcasts transactions to Stellar MAINNET. Requires audit approval."
	npm run deploy:mainnet

# ---------------------------------------------------------------------------
# Combined CI target  (offline, safe to run anywhere)
# ---------------------------------------------------------------------------

.PHONY: ci
ci: fmt lint-contracts test-contracts build-contracts build-scanner typecheck \
    lint-frontend test-frontend build-frontend \
    lint-sdk test-sdk build-sdk \
    test-relayer test-asp test-publisher \
    verify-deployment verify-artifacts notices-verify audit \
    ## Run all main CI checks locally (no network operations)
	@echo ""
	@echo "All CI checks passed."
