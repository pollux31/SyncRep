# SyncRep pour Obsidian

SyncRep est un plugin Obsidian qui synchronise automatiquement vos notes avec un répertoire externe sur votre disque dur.

## Fonctionnalités

- Synchronisation bidirectionnelle entre votre coffre Obsidian et un répertoire externe
- Synchronisation automatique lors de la sauvegarde des notes
- Synchronisation périodique configurable
- Possibilité d'exclure certains dossiers de la synchronisation
- Commande pour synchroniser manuellement à la demande
- Prise en charge des fichiers binaires (images, PDF, etc.)
- Gestion des renommages de fichiers et de dossiers
- Affichage en gras des dossiers synchronisés dans l'explorateur de fichiers
- Personnalisation de la couleur de surbrillance des dossiers synchronisés
- Synchronisation des dossiers vides (pas seulement ceux contenant des notes)
- Déplacement des fichiers et dossiers supprimés vers la corbeille (au lieu de les supprimer définitivement)
- Confirmation avant suppression de répertoires distants

## Installation

1. Copiez le dossier `SyncRep` dans le répertoire des plugins de votre coffre Obsidian (`VotreCoffre/.obsidian/plugins/`)
2. Activez le plugin dans les paramètres d'Obsidian (Paramètres > Plugins tiers)
3. Configurez le chemin du répertoire de synchronisation dans les paramètres du plugin

## Configuration

Dans les paramètres du plugin, vous pouvez configurer :

- **Chemin du répertoire de synchronisation** : le chemin absolu vers le répertoire où vos notes seront synchronisées
- **Synchroniser lors de la sauvegarde** : active/désactive la synchronisation automatique lors de la sauvegarde des notes
- **Intervalle de synchronisation** : définit l'intervalle en secondes pour la synchronisation périodique (0 pour désactiver)
- **Dossiers exclus** : liste des dossiers à exclure de la synchronisation
- **Dossiers inclus** : liste des dossiers spécifiques à inclure dans la synchronisation
- **Dossiers externes inclus** : liste des dossiers externes (hors du coffre) à inclure dans la synchronisation
- **Mode de synchronisation** : choisissez entre "Tout" (synchroniser tous les fichiers) ou "Liste" (synchroniser uniquement les fichiers spécifiés)
- **Mode débogage** : active/désactive les logs détaillés pour le débogage
- **Couleur de surbrillance** : personnalisez la couleur utilisée pour mettre en évidence les dossiers synchronisés

## Utilisation

Une fois configuré, le plugin fonctionne automatiquement en arrière-plan. Vous pouvez également utiliser la commande "Synchroniser maintenant" pour lancer une synchronisation manuelle à tout moment.

### Gestion des dossiers

- Les dossiers créés dans Obsidian sont automatiquement synchronisés avec le répertoire externe
- Les dossiers vides dans le répertoire externe sont également créés dans Obsidian lors de la synchronisation
- Lors de la suppression d'un dossier dans un dossier synchronisé, une confirmation vous sera demandée pour supprimer également le répertoire distant associé
- Les fichiers et dossiers supprimés sont déplacés vers la corbeille plutôt que d'être définitivement supprimés

## Architecture

Le plugin est organisé en modules pour une meilleure maintenabilité :

- **main.ts** : Point d'entrée du plugin, gère l'initialisation et les événements principaux
- **fileSync.ts** : Gère la synchronisation des fichiers individuels
- **directorySync.ts** : Gère la synchronisation des répertoires et la surveillance des changements
- **settings.ts** : Définit les types et les fonctions liés aux paramètres du plugin

## Développement

Pour compiler le plugin :

```bash
npm install
npm run build
```

## Licence

Ce plugin est sous licence MIT.

## Historique des versions

### 1.1.0 (1 avril 2025)
- Ajout de la personnalisation de la couleur de surbrillance pour les dossiers synchronisés
- Amélioration de la synchronisation des dossiers vides
- Déplacement des fichiers et dossiers supprimés vers la corbeille
- Ajout d'une confirmation avant la suppression de répertoires distants
- Optimisation et simplification du code

### 1.0.0
- Version initiale
