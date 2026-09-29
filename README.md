# Prigojine

**Pilote plusieurs téléphones et tablettes Android en même temps depuis ton PC : à la main, par macros, ou par un agent IA (Claude ou un modèle local).**

Interface web locale, en français, testée sous Windows 11.

## Fonctions

- **Grille d'écrans en direct** : vidéo fluide (via `adb screenrecord` + ffmpeg) ou captures ; tap, double tap, appui long, glisser, clavier du PC sur l'écran, Ctrl+V.
- **Plusieurs appareils en simultané**, avec un mode **synchro** qui répète tes actions sur tous les appareils cochés (positions adaptées à chaque écran).
- **Agent IA** par appareil, en parallèle : **Claude** (via la CLI Claude Code) ou un **modèle local Ollama**. Bouton « Continuer » qui garde le contexte.
- **Garde-fous** : ton accord est demandé avant « Envoyer », « Payer », « Supprimer », Entrée… ; plafond de dépense ; nombre d'actions maximal.
- **Macros** (enregistrer puis rejouer sur tous les appareils), **scripts**, **tableau de résultats** exportable en rapport HTML.
- **Émulateurs** : démarrage et arrêt (par lot), mode léger sans fenêtre (environ 4× moins de processeur), arrêt des émulateurs inutilisés, redémarrage automatique en cas de plantage.
- **Fichiers** : glisser-déposer un APK (installation) ou un fichier (envoi dans Téléchargements) ; parcourir et récupérer photos et documents.
- **Wi-Fi** : passage de l'USB au Wi-Fi en un clic, ou appairage par code (Android 11+).
- **Notifications** Windows : agent terminé, accord demandé, émulateur planté.

## Démarrer

### Installateur (Windows 10/11, 64 bits) — recommandé

Télécharge **`Installer-Prigojine.exe`** dans les [Releases](../../releases) et lance-le. Il installe :

- **Prigojine** (inclus dans l'installateur) ;
- les **composants Android** : SDK, émulateur et image Android 16, téléchargés depuis les serveurs de Google après acceptation de leur licence (≈ 2,4 Go, ignorés s'ils sont déjà présents) ;
- **ffmpeg** pour la vidéo fluide, téléchargé depuis les builds Windows officielles (gyan.dev) ;
- **2 émulateurs légers** prêts à l'emploi (un téléphone, une tablette) et des raccourcis.

Chaque téléchargement est vérifié par somme de contrôle. Désinstallation : Paramètres Windows → Applications → Prigojine (le SDK Android et les émulateurs sont conservés).

### Version portable

`Prigojine-portable.zip` (dans les Releases) : décompresse et double-clique sur **`Prigojine.exe`**. Node.js et adb sont inclus ; pour les émulateurs et la vidéo fluide, installe Android Studio et ffmpeg toi-même (ou utilise l'installateur).

### Depuis les sources

```bash
npm install
npm start
```

La page s'ouvre dans le navigateur. Sous Windows, tu peux aussi double-cliquer sur `Lancer-Prigojine.bat`.
Pour fabriquer la version portable : `npm run portable` (ou `Construire-portable.bat`) ; l'installateur : `npm run installer`.

### Prérequis selon les fonctions

| Fonction | Nécessite |
|---|---|
| Téléphones Android | débogage USB activé (adb est fourni dans la version portable) |
| Émulateurs | Android Studio (SDK + émulateur) |
| Vidéo fluide | ffmpeg dans le PATH |
| Agent Claude | [Claude Code](https://claude.com/claude-code) installé et connecté (`claude` puis `/login`) |
| Modèles locaux | [Ollama](https://ollama.com) avec un modèle compatible « tools » |

## Sécurité

- Le serveur n'écoute que sur `127.0.0.1` et refuse toute requête dont l'hôte n'est pas `localhost`.
- Une **clé d'accès aléatoire** est créée à chaque démarrage (`~/.prigojine/token-4717`). La page la reçoit à l'ouverture puis la garde dans un cookie `HttpOnly; SameSite=Strict` : un autre site web, ou une appli installée dans un émulateur, ne peut pas piloter tes appareils.
- Les agents ne pilotent que l'appareil qui leur est confié, n'ont pas accès aux fichiers du PC, et demandent ton accord avant toute action sensible.
- N'expose jamais le port 4717 sur un réseau : Prigojine pilote de vrais téléphones.

## Données locales

Tes captures (`captures/`), macros (`macros.json`) et réglages (`settings.json`) restent sur ton PC et sont exclus du dépôt.

## Licence

[MIT](LICENSE).
