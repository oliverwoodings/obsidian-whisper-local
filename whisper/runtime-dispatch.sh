#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_ROOT_DEFAULT="$(cd "${PLUGIN_ROOT}/.." && pwd)/whisper-local-runtime"
RUNTIME_ROOT="${WHISPER_RUNTIME_REPO:-${RUNTIME_ROOT_DEFAULT}}"
COMMAND_NAME="${1:-}"
shift || true

if [[ -z "${COMMAND_NAME}" ]]; then
	echo "Usage: $0 <script-name> [args...]" >&2
	exit 1
fi

TARGET_SCRIPT="${RUNTIME_ROOT}/whisper/${COMMAND_NAME}"
if [[ ! -x "${TARGET_SCRIPT}" ]]; then
	echo "Shared whisper runtime script not found: ${TARGET_SCRIPT}" >&2
	echo "Expected runtime repo: ${RUNTIME_ROOT}" >&2
	exit 1
fi

exec bash "${TARGET_SCRIPT}" "$@"
