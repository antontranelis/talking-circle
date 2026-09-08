#!/bin/bash
# Schiebt die Runden ins Session-Archiv.
#
# Das Archiv liest je Nutzer ein Verzeichnis mit .jsonl-Dateien; jede Runde ist
# darin eine Sitzung, die Sprecher sind die Rollen. Damit taucht ein Redekreis
# in Suche, Zusammenfassung und Wissensgraph neben den Sessions auf.
#
#   ./scripts/ins-archiv.sh [quelle] [ziel]
#
# Standard-Quelle ist ./transcripts, Standard-Ziel das Archiv auf Elis Server.
set -euo pipefail

QUELLE="${1:-$(dirname "$0")/../transcripts}"
ZIEL="${2:-eli@82.165.138.182:/home/eli/geist/archive/redekreis/}"

ANZAHL=$(find "$QUELLE" -maxdepth 1 -name '*.jsonl' | wc -l)
if [ "$ANZAHL" -eq 0 ]; then
  echo "Keine Runden in $QUELLE"
  exit 0
fi

echo "Übertrage $ANZAHL Runden nach $ZIEL"
rsync -az --include='*.jsonl' --exclude='*' "$QUELLE"/ "$ZIEL"
echo "Fertig. Das Archiv nimmt neue Dateien beim nächsten Durchlauf auf."
