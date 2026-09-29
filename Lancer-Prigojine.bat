@echo off
title Prigojine
cd /d "%~dp0"
if not exist node_modules (
  echo Premiere utilisation : installation des dependances...
  call npm install --omit=dev
)
echo Prigojine : la page va s'ouvrir dans ton navigateur.
echo Ferme cette fenetre pour arreter Prigojine.
node server.cjs --open
