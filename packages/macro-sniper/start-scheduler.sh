#!/bin/bash
cd /root/pi-mono/pi-mono/packages/macro-sniper
nohup node --env-file=.env --import tsx src/cli.ts jobs start > /tmp/macro-sniper-scheduler.log 2>&1 &
echo "PID: $!"
