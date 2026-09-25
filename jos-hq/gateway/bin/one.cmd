@ECHO off
REM J/OS HQ: `one` inside an HQ-dispatched executor resolves here and runs the HQ One gateway.
SETLOCAL
SET "_jos_node=%JOS_HQ_NODE%"
IF "%_jos_node%"=="" SET "_jos_node=node"
"%_jos_node%" "%~dp0..\one-gateway.mjs" %*
