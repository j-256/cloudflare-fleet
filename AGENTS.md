# Repository guidance

## Browser handoff

Whenever browser verification leaves this dashboard open for the user, ensure the final surviving launch is read/write (`./launch.sh --write`). Do not leave a read-only launch running; terminate it entirely instead.
