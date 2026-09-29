@ECHO off
REM J/OS HQ: runs an operator-approved action exactly as approved. See jos-hq/gateway/jos-approved.mjs.
SETLOCAL
SET "_jos_node=%JOS_HQ_NODE%"
IF "%_jos_node%"=="" SET "_jos_node=node"
"%_jos_node%" "%~dp0..\jos-approved.mjs" %*
