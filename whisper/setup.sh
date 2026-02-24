#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
ENV_EXAMPLE_FILE="${SCRIPT_DIR}/.env.example"

if [[ ! -f "${ENV_FILE}" ]]; then
	cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
	echo "Created ${ENV_FILE} from ${ENV_EXAMPLE_FILE}."
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

WHISPER_REPO_URL="${WHISPER_REPO_URL:-https://github.com/ggml-org/whisper.cpp.git}"
WHISPER_REPO_REF="${WHISPER_REPO_REF:-main}"
WHISPER_SRC_DIR="${WHISPER_SRC_DIR:-./whisper/whisper.cpp-src}"
WHISPER_BUILD_DIR="${WHISPER_BUILD_DIR:-./whisper/build}"
WHISPER_MODEL="${WHISPER_MODEL:-base.en}"
WHISPER_MODEL_FILE="${WHISPER_MODEL_FILE:-ggml-${WHISPER_MODEL}.bin}"
WHISPER_MODEL_DIR="${WHISPER_MODEL_DIR:-./whisper/models}"
WHISPER_MODEL_URL="${WHISPER_MODEL_URL:-}"
WHISPER_HOST="${WHISPER_HOST:-127.0.0.1}"
WHISPER_PORT="${WHISPER_PORT:-8080}"

resolve_path() {
	local value="$1"
	if [[ "${value}" == /* ]]; then
		printf '%s\n' "${value}"
	else
		printf '%s\n' "${REPO_ROOT}/${value#./}"
	fi
}

require_command() {
	local command_name="$1"
	if ! command -v "${command_name}" >/dev/null 2>&1; then
		echo "Missing required command: ${command_name}" >&2
		exit 1
	fi
}

cpu_count() {
	if command -v nproc >/dev/null 2>&1; then
		nproc
		return
	fi

	if command -v sysctl >/dev/null 2>&1; then
		sysctl -n hw.logicalcpu
		return
	fi

	echo 4
}

ensure_repo_checked_out() {
	local src_dir="$1"
	local repo_url="$2"
	local repo_ref="$3"

	if [[ ! -d "${src_dir}/.git" ]]; then
		echo "Cloning whisper.cpp (${repo_ref}) into ${src_dir}"
		if ! git clone --depth 1 --branch "${repo_ref}" "${repo_url}" "${src_dir}"; then
			if [[ "${repo_ref}" == "main" ]]; then
				echo "Falling back to branch 'master'..."
				git clone --depth 1 --branch "master" "${repo_url}" "${src_dir}"
			else
				return 1
			fi
		fi
		return 0
	fi

	echo "Using existing whisper.cpp checkout: ${src_dir}"
}

find_server_binary() {
	local build_dir="$1"
	local candidates=(
		"${build_dir}/bin/whisper-server"
		"${build_dir}/bin/Release/whisper-server"
		"${build_dir}/Release/bin/whisper-server"
	)

	for candidate in "${candidates[@]}"; do
		if [[ -x "${candidate}" ]]; then
			printf '%s\n' "${candidate}"
			return 0
		fi
	done

	return 1
}

require_command git
require_command cmake
require_command curl

WHISPER_SRC_DIR="$(resolve_path "${WHISPER_SRC_DIR}")"
WHISPER_BUILD_DIR="$(resolve_path "${WHISPER_BUILD_DIR}")"
WHISPER_MODEL_DIR="$(resolve_path "${WHISPER_MODEL_DIR}")"
mkdir -p "${WHISPER_MODEL_DIR}"

ensure_repo_checked_out "${WHISPER_SRC_DIR}" "${WHISPER_REPO_URL}" "${WHISPER_REPO_REF}"

echo "Configuring whisper.cpp build..."
cmake -S "${WHISPER_SRC_DIR}" -B "${WHISPER_BUILD_DIR}" \
	-DCMAKE_BUILD_TYPE=Release \
	-DWHISPER_BUILD_EXAMPLES=ON

echo "Building whisper.cpp (this may take a few minutes)..."
cmake --build "${WHISPER_BUILD_DIR}" --config Release -j "$(cpu_count)"

SERVER_BIN="$(find_server_binary "${WHISPER_BUILD_DIR}" || true)"
if [[ -z "${SERVER_BIN}" ]]; then
	echo "Build completed, but whisper-server binary was not found." >&2
	echo "Checked under: ${WHISPER_BUILD_DIR}/bin" >&2
	exit 1
fi

MODEL_PATH="${WHISPER_MODEL_DIR}/${WHISPER_MODEL_FILE}"
if [[ -z "${WHISPER_MODEL_URL}" ]]; then
	WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL_FILE}"
fi

if [[ -f "${MODEL_PATH}" ]]; then
	echo "Model already present: ${MODEL_PATH}"
else
	echo "Downloading model: ${WHISPER_MODEL_FILE}"
	echo "Source: ${WHISPER_MODEL_URL}"
	curl -fL --progress-bar "${WHISPER_MODEL_URL}" -o "${MODEL_PATH}"
	echo "Model downloaded to: ${MODEL_PATH}"
fi

cat <<MSG

whisper.cpp native setup complete.

Current configuration:
- env file: ${ENV_FILE}
- source dir: ${WHISPER_SRC_DIR}
- build dir: ${WHISPER_BUILD_DIR}
- server binary: ${SERVER_BIN}
- model: ${MODEL_PATH}
- server URL for plugin settings: http://${WHISPER_HOST}:${WHISPER_PORT}

Next step:
- Start server: npm run whisper:start

MSG
