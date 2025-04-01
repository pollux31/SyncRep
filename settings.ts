import { App, PluginSettingTab, Setting, Plugin, TFolder, Notice, TAbstractFile, TFile } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs';
import SyncRepPlugin from './main';

export interface SyncRepSettings {
    syncFolderPath: string;
    syncOnSave: boolean;
    syncInterval: number; // en secondes, 0 = désactivé
    excludedFolders: string[];
    includedFolders: string[]; // Dossiers du vault à inclure spécifiquement
    externalIncludedFolders: string[]; // Dossiers externes (hors vault) à inclure
    syncMode: 'all' | 'include'; // Mode de synchronisation: tout ou seulement les dossiers inclus
    debugMode: boolean; // Mode de débogage pour afficher les notifications et logs détaillés
    highlightColor: string; // Couleur pour les dossiers synchronisés
}

export const DEFAULT_SETTINGS: SyncRepSettings = {
    syncFolderPath: '',
    syncOnSave: true,
    syncInterval: 0,
    excludedFolders: [],
    includedFolders: [],
    externalIncludedFolders: [],
    syncMode: 'include',
    debugMode: false,
    highlightColor: '#50fa7b' // Couleur par défaut (vert)
};

export class SyncRepSettingTab extends PluginSettingTab {
    plugin: SyncRepPlugin;
    folderListEl: HTMLElement;
    folderDropdownContainer: HTMLElement;

    constructor(app: App, plugin: SyncRepPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // Récupérer tous les dossiers du vault
    getAllFolders(): TFolder[] {
        const folders: TFolder[] = [];
        const rootFolder = this.app.vault.getRoot();
        
        // Fonction récursive pour parcourir les dossiers
        const collectFolders = (folder: TFolder) => {
            folders.push(folder);
            
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    collectFolders(child);
                }
            }
        };
        
        collectFolders(rootFolder);
        return folders;
    }

    // Récupérer tous les fichiers d'un dossier de manière récursive
    getAllFilesInFolder(folder: TFolder): TAbstractFile[] {
        const files: TAbstractFile[] = [];
        
        // Fonction récursive pour parcourir les fichiers
        const collectFiles = (folder: TFolder) => {
            for (const child of folder.children) {
                if (child instanceof TFile) {
                    files.push(child);
                } else if (child instanceof TFolder) {
                    collectFiles(child);
                }
            }
        };
        
        collectFiles(folder);
        return files;
    }

    // Créer un élément de liste pour un dossier inclus
    createFolderListItem(folderPath: string, containerEl: HTMLElement) {
        const itemEl = containerEl.createDiv({ cls: 'sync-rep-folder-item' });
        
        // Ajouter du style CSS
        itemEl.style.display = 'flex';
        itemEl.style.justifyContent = 'space-between';
        itemEl.style.alignItems = 'center';
        itemEl.style.marginBottom = '8px';
        itemEl.style.padding = '6px';
        itemEl.style.backgroundColor = 'var(--background-secondary)';
        itemEl.style.borderRadius = '4px';
        
        // Afficher le chemin du dossier
        const pathEl = itemEl.createDiv();
        pathEl.textContent = folderPath;
        
        // Bouton de suppression
        const removeButton = itemEl.createEl('button', { text: 'Supprimer' });
        removeButton.style.marginLeft = '10px';
        
        // Gérer la suppression du dossier
        removeButton.addEventListener('click', async () => {
            const plugin = this.plugin as SyncRepPlugin;
            const index = plugin.settings.includedFolders.indexOf(folderPath);
            
            if (index > -1) {
                // Supprimer de la liste des dossiers inclus
                plugin.settings.includedFolders.splice(index, 1);
                
                // Sauvegarder les paramètres
                await plugin.saveSettings();
                
                // Rafraîchir l'interface complète pour mettre à jour la liste déroulante
                this.display();
                
                // Mettre à jour l'affichage des dossiers synchronisés dans l'explorateur
                plugin.highlightSyncedFolders();
                
                new Notice(`Dossier supprimé: ${folderPath}`);
            }
        });
        
        return itemEl;
    }

    // Rafraîchir la liste des dossiers inclus
    refreshFolderList() {
        const plugin = this.plugin as SyncRepPlugin;
        
        if (!this.folderListEl) return;
        
        this.folderListEl.empty();
        
        // Créer un élément pour chaque dossier inclus
        for (const folder of plugin.settings.includedFolders) {
            this.createFolderListItem(folder, this.folderListEl);
        }
    }

    // Rafraîchir la liste déroulante des dossiers disponibles
    refreshFolderDropdown(containerEl: HTMLElement) {
        const plugin = this.plugin as SyncRepPlugin;
        
        // Vider le conteneur existant
        containerEl.empty();
        
        // Créer un conteneur pour la sélection de dossier
        const folderSelectionContainer = containerEl.createDiv({ cls: 'sync-rep-folder-selection' });
        folderSelectionContainer.style.display = 'flex';
        folderSelectionContainer.style.marginBottom = '10px';
        
        // Liste déroulante des dossiers
        const folderSelect = folderSelectionContainer.createEl('select');
        folderSelect.style.flexGrow = '1';
        folderSelect.style.marginRight = '10px';
        
        // Option par défaut
        folderSelect.createEl('option', { text: 'Sélectionner un dossier...' }).value = '';
        
        // Groupe pour les dossiers du vault
        const vaultGroup = folderSelect.createEl('optgroup');
        vaultGroup.label = 'Dossiers du vault';
        
        // Ajouter tous les dossiers du vault
        const folders = this.getAllFolders();
        for (const folder of folders) {
            // Ignorer le dossier racine
            if (folder.path === '/') {
                vaultGroup.createEl('option', { text: '/ (Racine)' }).value = '';
            } else {
                vaultGroup.createEl('option', { text: folder.path }).value = folder.path;
            }
        }
        
        // Groupe pour les répertoires distants
        const remoteGroup = folderSelect.createEl('optgroup');
        remoteGroup.label = 'Répertoires distants';
        
        // Obtenir la liste des répertoires dans le dossier de synchronisation
        if (plugin.settings.syncFolderPath && fs.existsSync(plugin.settings.syncFolderPath)) {
            try {
                // Lire les répertoires dans le dossier de synchronisation
                const entries = fs.readdirSync(plugin.settings.syncFolderPath, { withFileTypes: true });
                let hasRemoteFolders = false;
                
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        hasRemoteFolders = true;
                        // Construire le chemin complet
                        const fullPath = path.join(plugin.settings.syncFolderPath, entry.name);
                        
                        // Vérifier si ce répertoire est déjà dans la liste des répertoires externes
                        const isAlreadyExternal = plugin.settings.externalIncludedFolders.some(
                            (externalPath: string) => externalPath === fullPath
                        );
                        
                        // Vérifier si ce dossier est déjà inclus dans les dossiers du vault
                        const isAlreadyIncluded = plugin.settings.includedFolders.includes(entry.name);
                        
                        // Afficher le statut du dossier
                        let displayText = entry.name;
                        if (isAlreadyIncluded) {
                            displayText += ' (déjà synchronisé)';
                        }
                        
                        // Si ce n'est pas déjà un répertoire externe, l'ajouter à la liste
                        if (!isAlreadyExternal) {
                            const option = remoteGroup.createEl('option', { text: displayText });
                            option.value = fullPath;
                            
                            // Désactiver l'option si le dossier est déjà inclus
                            if (isAlreadyIncluded) {
                                option.disabled = true;
                            }
                        }
                    }
                }
                
                // Si aucun répertoire distant n'a été trouvé, ajouter un message
                if (!hasRemoteFolders) {
                    remoteGroup.createEl('option', { 
                        text: 'Aucun répertoire trouvé dans le dossier distant' 
                    }).disabled = true;
                }
            } catch (error) {
                console.error(`Erreur lors de la lecture des répertoires dans ${plugin.settings.syncFolderPath}:`, error);
                remoteGroup.createEl('option', { 
                    text: `Erreur: ${error.message}` 
                }).disabled = true;
            }
        } else {
            // Si le chemin n'est pas défini ou n'existe pas
            if (!plugin.settings.syncFolderPath) {
                remoteGroup.createEl('option', { 
                    text: 'Veuillez d\'abord configurer le chemin du répertoire distant' 
                }).disabled = true;
            } else {
                remoteGroup.createEl('option', { 
                    text: `Le répertoire ${plugin.settings.syncFolderPath} n'existe pas` 
                }).disabled = true;
            }
        }
        
        // Bouton d'ajout
        const addButton = folderSelectionContainer.createEl('button', { text: 'Ajouter' });
        addButton.addEventListener('click', async () => {
            const selectedValue = folderSelect.value;
            
            if (!selectedValue) {
                new Notice('Veuillez sélectionner un dossier');
                return;
            }
            
            // Vérifier si c'est un chemin distant (commence par le dossier de synchronisation)
            if (plugin.settings.syncFolderPath && selectedValue.startsWith(plugin.settings.syncFolderPath)) {
                // C'est un répertoire distant
                const folderName = path.basename(selectedValue);
                
                // Vérifier si ce chemin est déjà inclus
                if (plugin.settings.includedFolders.includes(folderName)) {
                    new Notice(`Le dossier ${folderName} est déjà inclus dans la synchronisation`);
                    return;
                }
                
                // Ajouter temporairement à la liste des dossiers externes pour la synchronisation initiale
                if (!plugin.settings.externalIncludedFolders.includes(selectedValue)) {
                    plugin.settings.externalIncludedFolders.push(selectedValue);
                }
                
                // Créer le dossier dans le vault
                try {
                    await this.plugin.app.vault.createFolder(folderName);
                    new Notice(`Dossier ${folderName} créé dans le vault`);
                } catch (error) {
                    console.error(`Erreur lors de la création du dossier ${folderName}:`, error);
                    // On continue même si la création du dossier échoue
                }
                
                // Synchroniser immédiatement le dossier
                try {
                    await plugin.fileSync.syncFromExternal(selectedValue);
                    new Notice(`Synchronisation du dossier ${folderName} terminée`);
                } catch (error) {
                    console.error(`Erreur lors de la synchronisation du dossier ${selectedValue}:`, error);
                    new Notice(`Erreur lors de la synchronisation: ${error.message}`);
                }
                
                // Ajouter le dossier local à la liste des dossiers inclus
                plugin.settings.includedFolders.push(folderName);
                
                // Sauvegarder les paramètres
                await plugin.saveSettings();
                
                // Supprimer le dossier externe de la liste après la synchronisation initiale
                const externalIndex = plugin.settings.externalIncludedFolders.indexOf(selectedValue);
                if (externalIndex > -1) {
                    plugin.settings.externalIncludedFolders.splice(externalIndex, 1);
                    await plugin.saveSettings();
                }
                
                // Rafraîchir l'interface
                this.refreshFolderList();
                this.refreshFolderDropdown(containerEl);
                
                // Mettre à jour l'affichage des dossiers synchronisés dans l'explorateur
                plugin.highlightSyncedFolders();
            } else {
                // C'est un dossier du vault
                
                // Vérifier si ce dossier est déjà inclus
                if (plugin.settings.includedFolders.includes(selectedValue)) {
                    new Notice(`Le dossier ${selectedValue} est déjà inclus dans la synchronisation`);
                    return;
                }
                
                // Ajouter à la liste des dossiers inclus
                plugin.settings.includedFolders.push(selectedValue);
                
                // Sauvegarder les paramètres
                await plugin.saveSettings();
                
                // Rafraîchir l'interface
                this.refreshFolderList();
                this.refreshFolderDropdown(containerEl);
                
                // Mettre à jour l'affichage des dossiers synchronisés dans l'explorateur
                plugin.highlightSyncedFolders();
                
                new Notice(`Dossier ${selectedValue} ajouté à la synchronisation`);
            }
        });
        
        return folderSelectionContainer;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Paramètres de SyncRep' });

        // Chemin du répertoire de synchronisation
        new Setting(containerEl)
            .setName('Chemin du répertoire de synchronisation')
            .setDesc('Chemin absolu vers le répertoire où vos notes seront synchronisées')
            .addText(text => {
                text.setPlaceholder('Chemin du répertoire')
                    .setValue(this.plugin.settings.syncFolderPath)
                    .onChange(async (value) => {
                        // Sauvegarder la valeur mais ne pas rafraîchir l'interface
                        this.plugin.settings.syncFolderPath = value;
                        await this.plugin.saveSettings();
                    });
                
                // Ajouter un gestionnaire d'événement pour la perte de focus
                const inputEl = text.inputEl;
                inputEl.addEventListener('blur', () => {
                    // Rafraîchir l'interface complète à la perte du focus
                    this.display();
                });
                
                return text;
            });

        new Setting(containerEl)
            .setName('Synchroniser lors de la sauvegarde')
            .setDesc('Synchroniser automatiquement les notes lorsqu\'elles sont sauvegardées')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncOnSave)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnSave = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Intervalle de synchronisation (secondes)')
            .setDesc('Intervalle en secondes pour la synchronisation automatique (0 pour désactiver)')
            .addText(text => text
                .setPlaceholder('0')
                .setValue(String(this.plugin.settings.syncInterval))
                .onChange(async (value) => {
                    // Convertir la valeur en nombre
                    const numValue = parseInt(value, 10);
                    
                    // Vérifier si la valeur est un nombre valide
                    if (!isNaN(numValue) && numValue >= 0) {
                        this.plugin.settings.syncInterval = numValue;
                        await this.plugin.saveSettings();
                        this.plugin.restartSyncInterval();
                    }
                }));

        // Mode de débogage
        new Setting(containerEl)
            .setName('Mode débogage')
            .setDesc('Activer les notifications et les logs détaillés')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    await this.plugin.saveSettings();
                }));

        // Mode de synchronisation
        new Setting(containerEl)
            .setName('Mode de synchronisation')
            .setDesc('Choisir le mode de synchronisation')
            .addDropdown(dropdown => dropdown
                .addOption('all', 'Tous les fichiers (sauf exclusions)')
                .addOption('include', 'Uniquement les dossiers inclus')
                .setValue(this.plugin.settings.syncMode)
                .onChange(async (value) => {
                    this.plugin.settings.syncMode = value as 'all' | 'include';
                    await this.plugin.saveSettings();
                    
                    // Rafraîchir l'interface pour afficher/masquer les options pertinentes
                    this.display();
                    
                    // Si on passe en mode "include" et qu'aucun dossier n'est inclus,
                    // afficher une notification pour guider l'utilisateur
                    if (value === 'include' && this.plugin.settings.includedFolders.length === 0) {
                        new Notice('Veuillez sélectionner au moins un dossier à inclure dans la synchronisation');
                    }
                })
            );

        // Dossiers à inclure (visible uniquement si le mode est 'include')
        if (this.plugin.settings.syncMode === 'include') {
            // Section pour les dossiers inclus
            containerEl.createEl('h3', { text: 'Dossiers inclus dans la synchronisation' });
            
            // Conteneur pour la liste des dossiers
            this.folderListEl = containerEl.createDiv({ cls: 'sync-rep-folder-list' });
            this.folderListEl.style.marginBottom = '20px';
            
            // Afficher les dossiers actuellement inclus
            this.refreshFolderList();
            
            // Ajouter un nouveau dossier
            this.folderDropdownContainer = containerEl.createDiv();
            const folderSelectionContainer = this.refreshFolderDropdown(this.folderDropdownContainer);
        }

        // Dossiers externes à inclure
        const externalFolderSetting = new Setting(containerEl)
            .setName('Dossiers externes à inclure')
            .setDesc('Ajouter des dossiers externes (hors vault) à inclure dans la synchronisation');
            
        // Référence pour stocker l'élément input
        let externalPathInput: HTMLInputElement;
        
        externalFolderSetting.addText(text => {
            text.setPlaceholder('C:\\Chemin\\vers\\dossier')
                .setValue('')
                .onChange(async (value) => {
                    // Ne rien faire ici, on utilisera le bouton pour ajouter
                });
                
            // Stocker la référence à l'élément input
            externalPathInput = text.inputEl;
            
            return text;
        });
            
        externalFolderSetting.addButton(button => {
            button.setButtonText('Ajouter')
                .onClick(async () => {
                    // Récupérer la valeur du champ texte
                    const externalPath = externalPathInput.value.trim();
                    
                    if (externalPath) {
                        // Ajouter le dossier externe
                        const success = await this.addExternalFolder(externalPath);
                        
                        if (success) {
                            // Vider le champ texte
                            externalPathInput.value = '';
                            
                            // Rafraîchir l'interface
                            this.display();
                        }
                    } else {
                        new Notice('Veuillez entrer un chemin de dossier valide');
                    }
                });
                
            return button;
        });
            
        // Afficher la liste des dossiers externes
        if (this.plugin.settings.externalIncludedFolders.length > 0) {
            containerEl.createEl('h3', { text: 'Dossiers externes configurés' });
            
            const externalFolderListEl = containerEl.createDiv({ cls: 'sync-rep-folder-list' });
            
            for (const externalFolder of this.plugin.settings.externalIncludedFolders) {
                const itemEl = externalFolderListEl.createDiv({ cls: 'sync-rep-folder-item' });
                
                // Ajouter du style CSS
                itemEl.style.display = 'flex';
                itemEl.style.justifyContent = 'space-between';
                itemEl.style.alignItems = 'center';
                itemEl.style.marginBottom = '8px';
                itemEl.style.padding = '6px';
                itemEl.style.backgroundColor = 'var(--background-secondary)';
                itemEl.style.borderRadius = '4px';
                
                // Afficher le chemin du dossier externe
                const pathEl = itemEl.createDiv();
                pathEl.textContent = externalFolder;
                
                // Afficher le nom du dossier dans le vault
                const folderName = path.basename(externalFolder);
                const vaultPathEl = itemEl.createDiv();
                vaultPathEl.style.marginLeft = '10px';
                vaultPathEl.style.color = 'var(--text-accent)';
                vaultPathEl.textContent = `→ ${folderName}`;
                
                // Bouton de suppression
                const removeButton = itemEl.createEl('button', { text: 'Supprimer' });
                removeButton.style.marginLeft = '10px';
                
                // Gérer la suppression du dossier externe
                removeButton.addEventListener('click', async () => {
                    const index = this.plugin.settings.externalIncludedFolders.indexOf(externalFolder);
                    
                    if (index > -1) {
                        // Supprimer de la liste des dossiers externes
                        this.plugin.settings.externalIncludedFolders.splice(index, 1);
                        
                        // Sauvegarder les paramètres
                        await this.plugin.saveSettings();
                        
                        // Mettre à jour l'affichage des dossiers synchronisés dans l'explorateur
                        this.plugin.highlightSyncedFolders();
                        
                        // Rafraîchir l'interface complète
                        this.display();
                        
                        new Notice(`Dossier externe supprimé: ${folderName}`);
                    }
                });
            }
        } else {
            containerEl.createEl('p', { 
                text: 'Aucun dossier externe configuré. Utilisez le champ ci-dessus pour ajouter des dossiers externes.',
                cls: 'sync-rep-info-text'
            });
        }

        // Dossiers à exclure (toujours visible)
        new Setting(containerEl)
            .setName('Dossiers exclus')
            .setDesc('Liste des dossiers à exclure de la synchronisation (séparés par des virgules)')
            .addTextArea(text => text
                .setPlaceholder('dossier1, dossier2, dossier3')
                .setValue(this.plugin.settings.excludedFolders.join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.excludedFolders = value.split(',').map(folder => folder.trim()).filter(folder => folder.length > 0);
                    await this.plugin.saveSettings();
                }));

        // Couleur de mise en évidence
        new Setting(containerEl)
            .setName('Couleur de mise en évidence')
            .setDesc('Couleur utilisée pour mettre en évidence les dossiers synchronisés')
            .addColorPicker(colorPicker => colorPicker
                .setValue(this.plugin.settings.highlightColor)
                .onChange(async (value) => {
                    this.plugin.settings.highlightColor = value;
                    await this.plugin.saveSettings();
                    
                    // Mettre à jour les styles et rafraîchir l'affichage des dossiers synchronisés
                    this.plugin.updateStyles();
                    this.plugin.highlightSyncedFolders();
                }));
    }

    /**
     * Ajouter un dossier externe à la liste des dossiers inclus
     * @param externalPath Chemin absolu du dossier externe
     * @returns true si l'ajout a réussi, false sinon
     */
    async addExternalFolder(externalPath: string): Promise<boolean> {
        try {
            // Vérifier si le chemin existe
            if (!fs.existsSync(externalPath)) {
                new Notice(`Le dossier ${externalPath} n'existe pas`);
                return false;
            }
            
            // Vérifier si c'est bien un dossier
            const stats = fs.statSync(externalPath);
            if (!stats.isDirectory()) {
                new Notice(`${externalPath} n'est pas un dossier`);
                return false;
            }
            
            // Obtenir le nom du dossier
            const folderName = path.basename(externalPath);
            
            // Vérifier si un dossier avec ce nom existe déjà dans le vault
            const existingFolder = this.plugin.app.vault.getAbstractFileByPath(folderName);
            if (existingFolder) {
                new Notice(`Un dossier nommé ${folderName} existe déjà dans le vault`);
                return false;
            }
            
            const plugin = this.plugin as SyncRepPlugin;
            
            // Ajouter temporairement le dossier externe à la liste pour la synchronisation initiale
            plugin.settings.externalIncludedFolders.push(externalPath);
            
            // Créer le dossier dans le vault
            try {
                await this.plugin.app.vault.createFolder(folderName);
                new Notice(`Dossier ${folderName} créé dans le vault`);
            } catch (error) {
                console.error(`Erreur lors de la création du dossier ${folderName}:`, error);
                // On continue même si la création du dossier échoue, car il sera créé lors de la synchronisation
            }
            
            // Synchroniser immédiatement le dossier
            try {
                await plugin.fileSync.syncFromExternal(externalPath);
                new Notice(`Synchronisation du dossier ${folderName} terminée`);
            } catch (error) {
                console.error(`Erreur lors de la synchronisation du dossier ${externalPath}:`, error);
                new Notice(`Erreur lors de la synchronisation: ${error.message}`);
            }
            
            // Ajouter le dossier local à la liste des dossiers inclus
            if (!plugin.settings.includedFolders.includes(folderName)) {
                plugin.settings.includedFolders.push(folderName);
            }
            
            // Sauvegarder les paramètres
            await plugin.saveSettings();
            
            // Supprimer le dossier externe de la liste après la synchronisation initiale
            const externalIndex = plugin.settings.externalIncludedFolders.indexOf(externalPath);
            if (externalIndex > -1) {
                plugin.settings.externalIncludedFolders.splice(externalIndex, 1);
                await plugin.saveSettings();
            }
            
            // Mettre à jour l'affichage des dossiers synchronisés dans l'explorateur
            plugin.highlightSyncedFolders();
            
            return true;
        } catch (error) {
            console.error(`Erreur lors de l'ajout du dossier externe ${externalPath}:`, error);
            new Notice(`Erreur: ${error.message}`);
            return false;
        }
    }
}
