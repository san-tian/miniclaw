#!/bin/bash
pids=$(pgrep -f "gateway" | grep -v $$)
if [ -z "$pids" ]; then
  echo "No gateway process found."
else
  echo "Killing gateway processes: $pids"
  kill $pids
  echo "Done."
fi
