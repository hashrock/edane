#!/usr/bin/env bash
# Run the Alloy structural model headlessly.
#
# Needs the Alloy 6 dist jar. Fetch it from Maven Central (no GitHub needed):
#   curl -sSL -o alloy.jar \
#     https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/6.2.0/org.alloytools.alloy.dist-6.2.0.jar
#
# Usage:  ALLOY_JAR=/path/to/alloy.jar ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
JAR="${ALLOY_JAR:-alloy.jar}"
if [ ! -f "$JAR" ]; then
  echo "alloy.jar not found. Set ALLOY_JAR or place alloy.jar here." >&2
  echo "  curl -sSL -o alloy.jar https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/6.2.0/org.alloytools.alloy.dist-6.2.0.jar" >&2
  exit 1
fi
javac -cp "$JAR" RunAlloy.java
java -Dorg.slf4j.simpleLogger.defaultLogLevel=off -cp "$JAR:." RunAlloy CollapseVisibility.als
