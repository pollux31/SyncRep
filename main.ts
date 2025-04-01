import { App, Editor, MarkdownView, Notice, Plugin, TFile, TFolder, Vault, WorkspaceLeaf, View } from 'obsidian';
import { SyncRepSettings, DEFAULT_SETTINGS, SyncRepSettingTab } from './settings';
import { FileSync } from './fileSync';
import { DirectorySync } from './directorySync';
import * as fs from 'fs';
import * as path from 'path';

export default class SyncRepPlugin extends Plugin {
	settings: SyncRepSettings;
	syncIntervalId: NodeJS.Timeout | null = null;
	fileSync: FileSync;
	directorySync: DirectorySync;

	// Méthode unifiée pour la journalisation de débogage
	debug(message: string, notify: boolean = false) {
		if (this.settings.debugMode) {
			console.log(`[SyncRep] ${message}`);
			if (notify) {
				new Notice(`[SyncRep] ${message}`);
			}
		}
	}
	
	// Pour la compatibilité avec le code existant
	debugNotice(message: string) {
		this.debug(message, true);
	}

	debugLog(...args: any[]) {
		if (this.settings.debugMode) {
			console.log('[SyncRep]', ...args);
		}
	}

	async onload() {
		await this.loadSettings();

		// Initialiser les modules de synchronisation
		this.fileSync = new FileSync(this.app, this.settings);
		this.directorySync = new DirectorySync(this.app, this.settings, this.fileSync);

		// Ajouter l'onglet de paramètres
		this.addSettingTab(new SyncRepSettingTab(this.app, this));

		// Enregistrer les événements de modification de fichier
		this.registerFileEvents();

		// Effectuer une synchronisation initiale depuis le répertoire externe
		if (this.settings.syncFolderPath && fs.existsSync(this.settings.syncFolderPath)) {
			// Utiliser setTimeout pour laisser Obsidian terminer son chargement
			setTimeout(async () => {
				this.debugNotice('Synchronisation initiale depuis le répertoire externe...');
				try {
					await this.syncFromExternal();
					this.debugNotice('Synchronisation initiale terminée');
				} catch (error) {
					console.error('Erreur lors de la synchronisation initiale:', error);
					this.debugNotice(`Erreur lors de la synchronisation initiale: ${error.message}`);
				}
			}, 2000); // Attendre 2 secondes pour laisser Obsidian se charger complètement
		}

		// Démarrer l'intervalle de synchronisation si configuré
		this.restartSyncInterval();

		// Configurer la surveillance du répertoire externe
		this.directorySync.setupExternalWatcher();

		// Ajouter une commande pour synchroniser manuellement
		this.addCommand({
			id: 'sync-now',
			name: 'Synchroniser maintenant',
			callback: () => this.syncAllFiles(),
		});

		// Ajouter une commande pour synchroniser depuis le répertoire externe
		this.addCommand({
			id: 'sync-from-external',
			name: 'Synchroniser depuis le répertoire externe',
			callback: () => this.syncFromExternal(),
		});

		// Ajouter une feuille de style pour les dossiers synchronisés
		this.addStyle();

		// Observer les changements dans l'explorateur de fichiers pour mettre à jour les styles
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.highlightSyncedFolders();
			})
		);

		// Appliquer les styles initiaux
		setTimeout(() => {
			this.highlightSyncedFolders();
		}, 1000);

		// Notification de chargement du plugin
		this.debugNotice('Plugin SyncRep chargé');
	}

	onunload() {
		// Arrêter l'intervalle de synchronisation
		if (this.syncIntervalId) {
			clearInterval(this.syncIntervalId);
		}

		// Fermer tous les observateurs de fichiers
		this.directorySync.closeFileWatchers();

		// Supprimer les styles personnalisés
		this.removeStyle();

		this.debugNotice('Plugin SyncRep déchargé');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		
		// Mettre à jour les références aux paramètres dans les modules
		if (this.fileSync) {
			this.fileSync.updateSettings(this.settings);
		}
		
		if (this.directorySync) {
			this.directorySync.updateSettings(this.settings);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);

		// Mettre à jour les références aux paramètres dans les modules
		if (this.fileSync) {
			this.fileSync.updateSettings(this.settings);
		}
		
		if (this.directorySync) {
			this.directorySync.updateSettings(this.settings);
		}

		// Reconfigurer la surveillance du répertoire externe après un changement de paramètres
		this.directorySync.setupExternalWatcher();
		
		// Mettre à jour les styles pour refléter les changements de couleur
		this.updateStyles();
		
		// Mettre à jour l'affichage des dossiers synchronisés
		this.highlightSyncedFolders();
	}

	restartSyncInterval() {
		// Arrêter l'intervalle existant s'il y en a un
		if (this.syncIntervalId) {
			clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}

		// Démarrer un nouvel intervalle si l'intervalle est supérieur à 0
		if (this.settings.syncInterval > 0) {
			this.syncIntervalId = setInterval(
				() => this.syncAllFiles(),
				this.settings.syncInterval * 1000
			);
		}
	}

	shouldSyncFile(filePath: string): boolean {
		return this.fileSync.shouldSyncFile(filePath);
	}

	isIncluded(filePath: string): boolean {
		return this.fileSync.isIncluded(filePath);
	}

	async handleExternalFileChange(fullPath: string, relativePath: string) {
		return this.fileSync.handleExternalFileChange(fullPath, relativePath);
	}

	async handleExternalFileDeletion(relativePath: string) {
		return this.fileSync.handleExternalFileDeletion(relativePath);
	}

	async syncAllFiles() {
		if (!this.settings.syncFolderPath) {
			this.debugNotice('Chemin de synchronisation non configuré');
			return;
		}

		try {
			// Vérifier si le répertoire de synchronisation existe
			if (!fs.existsSync(this.settings.syncFolderPath)) {
				fs.mkdirSync(this.settings.syncFolderPath, { recursive: true });
			}

			// Récupérer tous les fichiers du vault
			const files = this.app.vault.getFiles();

			// Synchroniser chaque fichier qui doit l'être selon les paramètres
			for (const file of files) {
				if (this.fileSync.shouldSyncFile(file.path)) {
					await this.fileSync.syncFile(file);
				}
			}

			this.debugNotice('Synchronisation terminée');
		} catch (error) {
			console.error('Erreur lors de la synchronisation:', error);
			this.debugNotice(`Erreur de synchronisation: ${error.message}`);
		}
	}

	async syncFromExternal() {
		if (!this.settings.syncFolderPath || !fs.existsSync(this.settings.syncFolderPath)) {
			this.debugNotice('Répertoire de synchronisation non configuré ou inexistant');
			return;
		}

		try {
			this.debugLog('Démarrage de la synchronisation depuis l\'externe');
			this.debugNotice('Synchronisation depuis l\'externe en cours...');

			// Marquer que nous sommes en train de traiter une synchronisation complète
			this.fileSync.setProcessingExternalChange(true);

			try {
				// Utiliser la nouvelle méthode qui synchronise tous les répertoires, y compris les vides
				await this.directorySync.syncAllExternalDirectories();

				this.debugNotice('Synchronisation depuis l\'externe terminée');
			} finally {
				// Réinitialiser le drapeau après un délai
				setTimeout(() => {
					this.fileSync.setProcessingExternalChange(false);
				}, 500);
			}
		} catch (error) {
			console.error('Erreur lors de la synchronisation depuis l\'externe:', error);
			this.debugNotice(`Erreur lors de la synchronisation: ${error.message}`);
		}
	}

	isExcluded(filePath: string): boolean {
		return this.fileSync.isExcluded(filePath);
	}

	// Déterminer si un fichier est binaire en fonction de son extension
	isBinaryFileType(filePath: string): boolean {
		return this.fileSync.isBinaryFileType(filePath);
	}

	async handleFileDeletion(filePath: string) {
		return this.fileSync.handleFileDeletion(filePath);
	}

	registerFileEvents() {
		// Événement de modification de fichier
		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				if (file instanceof TFile && this.settings.syncOnSave && this.fileSync.shouldSyncFile(file.path)) {
					await this.fileSync.syncFile(file);
				}
			})
		);

		// Événement de création de fichier
		this.registerEvent(
			this.app.vault.on('create', async (file) => {
				if (file instanceof TFile && this.fileSync.shouldSyncFile(file.path)) {
					await this.fileSync.syncFile(file);
				} else if (file instanceof TFolder && this.fileSync.shouldSyncFile(file.path)) {
					// Synchroniser le dossier immédiatement lors de sa création
					await this.fileSync.syncFolder(file);
				}
			})
		);

		// Événement de suppression de fichier
		this.registerEvent(
			this.app.vault.on('delete', async (file) => {
				if (file instanceof TFile && this.fileSync.shouldSyncFile(file.path)) {
					await this.fileSync.handleFileDeletion(file.path);
				} else if (file instanceof TFolder && this.fileSync.shouldSyncFile(file.path)) {
					// Gérer la suppression de dossier avec confirmation
					await this.directorySync.handleFolderDeletion(file.path);
				}
			})
		);

		// Événement de renommage de fichier
		this.registerEvent(
			this.app.vault.on('rename', async (file, oldPath) => {
				if (file instanceof TFile) {
					// Vérifier si les deux chemins doivent être synchronisés
					const oldShouldSync = this.fileSync.shouldSyncFile(oldPath);
					const newShouldSync = this.fileSync.shouldSyncFile(file.path);
					
					if (oldShouldSync && newShouldSync) {
						// Si les deux chemins doivent être synchronisés, renommer le fichier externe
						const renamed = await this.fileSync.handleFileRename(oldPath, file.path);
						
						// Si le renommage a échoué ou si le fichier source n'existait pas, synchroniser le nouveau fichier
						if (!renamed) {
							await this.fileSync.syncFile(file);
						}
					} else if (oldShouldSync) {
						// Si seulement l'ancien chemin était synchronisé, supprimer le fichier externe
						await this.fileSync.handleFileDeletion(oldPath);
					} else if (newShouldSync) {
						// Si seulement le nouveau chemin doit être synchronisé, créer le fichier externe
						await this.fileSync.syncFile(file);
					}
				} else if (file instanceof TFolder) {
					// Gérer le renommage de dossier
					if (this.fileSync.shouldSyncFile(oldPath) || this.fileSync.shouldSyncFile(file.path)) {
						await this.directorySync.handleFolderRename(file, oldPath);
					}
				}
			})
		);
	}

	async ensureVaultDirectory(dirPath: string) {
		return this.fileSync.ensureVaultDirectory(dirPath);
	}

	// Mettre en évidence les dossiers synchronisés dans l'explorateur de fichiers
	highlightSyncedFolders() {
		// Trouver l'explorateur de fichiers
		const fileExplorers = this.getFileExplorers();

		if (!fileExplorers.length) {
			return;
		}

		// S'assurer que les styles sont à jour
		this.updateStyles();

		// Pour chaque explorateur de fichiers trouvé
		for (const fileExplorer of fileExplorers) {
			// Récupérer tous les éléments de dossier
			const folderEls = fileExplorer.querySelectorAll('.nav-folder');

			// Supprimer d'abord toutes les classes existantes
			folderEls.forEach((folderEl) => {
				folderEl.classList.remove('syncrep-synced');
				
				// Supprimer également le style en gras du contenu du titre
				const titleContentEl = folderEl.querySelector('.nav-folder-title-content');
				if (titleContentEl) {
					(titleContentEl as HTMLElement).style.fontWeight = 'normal';
				}
			});

			// Ajouter la classe aux dossiers synchronisés
			folderEls.forEach((folderEl) => {
				const titleEl = folderEl.querySelector('.nav-folder-title-content');
				if (titleEl) {
					const folderPath = this.getFolderPathFromTitle(titleEl, folderEl);
					
					if (folderPath) {
						// Vérifier si le dossier est inclus directement (exact match, pas de sous-dossiers)
						const isIncluded = this.settings.includedFolders.includes(folderPath);
						
						// Vérifier si le dossier correspond exactement à un dossier externe
						let isExternalFolder = false;
						for (const externalFolder of this.settings.externalIncludedFolders) {
							const folderName = path.basename(externalFolder);
							if (folderPath === folderName) {
								isExternalFolder = true;
								break;
							}
						}
						
						// Ne pas utiliser shouldSyncFile qui inclut les sous-dossiers
						// Mettre en évidence uniquement les dossiers explicitement sélectionnés
						if (isIncluded || isExternalFolder) {
							folderEl.classList.add('syncrep-synced');
							
							// Nous n'appliquons plus le style directement ici,
							// car il sera appliqué via CSS dans updateStyles()
							
							this.debugLog(`Dossier mis en évidence: ${folderPath}`);
						}
					}
				}
			});
		}
	}

	// Ajouter une feuille de style pour les dossiers synchronisés
	addStyle() {
		const styleEl = document.createElement('style');
		styleEl.id = 'syncrep-styles';
		this.updateStyleContent(styleEl);
		document.head.appendChild(styleEl);
	}
	
	// Mettre à jour le contenu des styles
	updateStyleContent(styleEl: HTMLStyleElement) {
		styleEl.textContent = `
			.nav-folder.syncrep-synced > .nav-folder-title {
				color: ${this.settings.highlightColor} !important;
			}
			.nav-folder.syncrep-synced > .nav-folder-title .nav-folder-title-content {
				font-weight: bold !important;
			}
			.theme-dark .nav-folder.syncrep-synced > .nav-folder-title:hover,
			.theme-light .nav-folder.syncrep-synced > .nav-folder-title:hover {
				color: ${this.settings.highlightColor} !important;
			}
		`;
		
		this.debugLog(`Styles mis à jour avec la couleur: ${this.settings.highlightColor}`);
	}
	
	// Mettre à jour les styles existants
	updateStyles() {
		const styleEl = document.getElementById('syncrep-styles');
		if (styleEl && styleEl instanceof HTMLStyleElement) {
			this.updateStyleContent(styleEl);
		} else {
			// Si l'élément de style n'existe pas, l'ajouter
			this.addStyle();
		}
	}

	// Supprimer la feuille de style
	removeStyle() {
		const styleEl = document.getElementById('syncrep-styles');
		if (styleEl) {
			styleEl.remove();
		}
	}

	// Obtenir les instances de l'explorateur de fichiers
	getFileExplorers(): HTMLElement[] {
		const fileExplorers: HTMLElement[] = [];

		// Parcourir toutes les feuilles de l'espace de travail
		this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
			// Vérifier si la vue est un explorateur de fichiers
			const view = leaf.view;
			if (view.getViewType() === 'file-explorer') {
				// Obtenir l'élément DOM de l'explorateur
				const containerEl = (view as any).containerEl;
				if (containerEl) {
					fileExplorers.push(containerEl);
				}
			}
		});

		return fileExplorers;
	}

	// Obtenir le chemin du dossier à partir de son titre dans l'explorateur
	getFolderPathFromTitle(titleEl: Element, folderEl: Element): string | null {
		// Récupérer le titre du dossier
		const folderTitle = titleEl.textContent;
		if (!folderTitle) {
			return null;
		}

		// Construire le chemin complet en remontant la hiérarchie
		let path = folderTitle;
		let parentFolderEl = folderEl.parentElement?.closest('.nav-folder');

		while (parentFolderEl) {
			const parentTitleEl = parentFolderEl.querySelector('.nav-folder-title-content');
			if (parentTitleEl && parentTitleEl.textContent) {
				// Ajouter le nom du dossier parent au début du chemin
				path = parentTitleEl.textContent + '/' + path;
			}
			parentFolderEl = parentFolderEl.parentElement?.closest('.nav-folder');
		}

		return path;
	}
}
