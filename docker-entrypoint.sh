#!/bin/sh
# Sorgt dafür, dass ein Sprachmodell da ist, bevor der Server startet.
set -e

REPO="handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf"
DATEI="nemotron-3.5-asr-streaming-0.6b-${MODELL_QUANT}.gguf"
ZIEL="${MODELL_ORDNER}/${DATEI}"

if [ -z "${TALKING_CIRCLE_MODEL}" ]; then
  if [ ! -f "${ZIEL}" ]; then
    echo "Sprachmodell fehlt, wird einmalig geladen: ${DATEI}"
    echo "(rund 700 MB; mit einem Volume auf ${MODELL_ORDNER} passiert das nur beim ersten Start)"
    curl -fL --retry 3 --progress-bar \
      -o "${ZIEL}.teil" \
      "https://huggingface.co/${REPO}/resolve/main/${DATEI}?download=true"
    mv "${ZIEL}.teil" "${ZIEL}"
    echo "Modell liegt unter ${ZIEL}"
  fi
  TALKING_CIRCLE_MODEL="${ZIEL}"
  export TALKING_CIRCLE_MODEL
fi

exec "$@"
