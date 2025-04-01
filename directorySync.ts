import { App, Modal, Notice, TFile, TFolder, TAbstractFile, Vault, Setting, ButtonComponent } from 'obsidian';
import { SyncRepSettings } from './settings';
import { FileSync } from './fileSync';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const fsReaddir = promisify(fs.readdir);
const fsStat = promisify(fs.stat);
const fsReadFile = promisify(fs.readFile);

// Classe pour la boîte de dialogue de confirmation
class ConfirmationModal extends Modal {
    private message: string;
    private onConfirm: (confirmed: boolean) => void;

    constructor(app: App, message: string, onConfirm: (confirmed: boolean) => void) {
        super(app);
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Confirmation' });
        contentEl.createEl('p', { text: this.message });
        
        const buttonContainer = contentEl.createDiv({ cls: 'sync-rep-button-container' });
        
        // Bouton Oui
        new ButtonComponent(buttonContainer)
            .setButtonText('Oui')
            .onClick(() => {
                this.onConfirm(true);
                this.close();
            });
        
        // Bouton Non
        new ButtonComponent(buttonContainer)
            .setButtonText('Non')
            .onClick(() => {
                this.onConfirm(false);
                this.close();
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class DirectorySync {
    private app: App;
    private settings: SyncRepSettings;
    private fileSync: FileSync;
    private fileWatchers: fs.FSWatcher[] = [];
    
    constructor(app: App, settings: SyncRepSettings, fileSync: FileSync) {
        this.app = app;
        this.settings = settings;
        this.fileSync = fileSync;
    }

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
        this.debug(args.join(' '));
    }

    // Mettre à jour les paramètres
    updateSettings(settings: SyncRepSettings) {
        this.settings = settings;
    }

    setupExternalWatcher() {
        // Fermer les observateurs existants
        this.closeFileWatchers();
        
        if (!this.settings.syncFolderPath || !fs.existsSync(this.settings.syncFolderPath)) {
            return;
        }

        try {
            // Créer un observateur pour le répertoire principal avec l'option recursive: true
            // Cela permet de surveiller tous les sous-répertoires en une seule fois
            const watcher = fs.watch(this.settings.syncFolderPath, { recursive: true }, async (eventType, filename) => {
                if (!filename) return;
                
                // Si nous sommes déjà en train de traiter un changement externe, ignorer cet événement
                if (this.fileSync.getProcessingExternalChange()) {
                    this.debugLog(`Événement ignoré car déjà en train de traiter un changement externe: ${filename}`);
                    return;
                }
                
                // Normaliser le chemin du fichier (remplacer les backslashes par des slashes)
                const normalizedFilename = filename.replace(/\\/g, '/');
                
                // Vérifier si le fichier est exclu
                if (this.fileSync.isExcluded(normalizedFilename)) {
                    return;
                }
                
                // Construire le chemin complet du fichier modifié
                const fullPath = path.join(this.settings.syncFolderPath, filename);
                
                this.debugLog(`Événement détecté: ${eventType} pour le fichier ${normalizedFilename}`);
                
                // Vérifier si le fichier existe et est un fichier (pas un répertoire)
                try {
                    const stats = await fsStat(fullPath);
                    
                    if (stats.isDirectory()) {
                        // Si c'est un répertoire, l'ajouter à la surveillance
                        if (!this.isDirectoryWatched(fullPath)) {
                            this.watchDirectory(fullPath);
                        }
                        
                        // Vérifier si c'est un nouveau répertoire qui doit être créé dans Obsidian
                        if (eventType === 'rename') {
                            await this.handleExternalDirectoryCreation(fullPath, normalizedFilename);
                        }
                        
                        return;
                    }
                    
                    this.debugLog(`Modification détectée pour le fichier externe: ${normalizedFilename}`);
                    
                    // Attendre un court délai pour éviter de traiter des fichiers en cours d'écriture
                    setTimeout(() => {
                        this.fileSync.handleExternalFileChange(fullPath, normalizedFilename);
                    }, 500);
                } catch (error) {
                    // Le fichier a peut-être été supprimé
                    if (eventType === 'rename') {
                        // Vérifier si c'est un répertoire qui a été supprimé
                        const dirPath = path.dirname(fullPath);
                        const baseName = path.basename(fullPath);
                        
                        try {
                            const parentDirEntries = await fsReaddir(dirPath, { withFileTypes: true });
                            const dirExists = parentDirEntries.some(entry => 
                                entry.isDirectory() && entry.name === baseName
                            );
                            
                            if (!dirExists) {
                                // C'est peut-être un répertoire qui a été renommé ou supprimé
                                // Vérifier si c'est un répertoire dans Obsidian
                                const relativeDirPath = path.relative(this.settings.syncFolderPath, fullPath).replace(/\\/g, '/');
                                const existingDir = this.app.vault.getAbstractFileByPath(relativeDirPath);
                                
                                if (existingDir instanceof TFolder) {
                                    // C'est un répertoire qui a été supprimé
                                    await this.handleExternalDirectoryDeletion(relativeDirPath);
                                } else {
                                    // C'est probablement un fichier qui a été supprimé
                                    this.debugLog(`Suppression détectée pour le fichier externe: ${normalizedFilename}`);
                                    this.fileSync.handleExternalFileDeletion(normalizedFilename);
                                }
                            }
                        } catch (dirError) {
                            // Si on ne peut pas lire le répertoire parent, c'est probablement un fichier supprimé
                            this.debugLog(`Suppression détectée pour le fichier externe: ${normalizedFilename}`);
                            this.fileSync.handleExternalFileDeletion(normalizedFilename);
                        }
                    }
                }
            });
            
            this.fileWatchers.push(watcher);
            this.debugLog(`Surveillance configurée pour le répertoire: ${this.settings.syncFolderPath} (mode récursif)`);
        } catch (error) {
            console.error('Erreur lors de la configuration de la surveillance:', error);
            this.debugNotice(`Erreur de configuration de la surveillance: ${error.message}`);
            
            // Essayer une approche alternative en cas d'échec du mode récursif
            this.setupFallbackWatcher();
        }
    }
    
    setupFallbackWatcher() {
        this.debugLog("Utilisation du mode de surveillance de secours (non récursif)");
        try {
            // Surveiller le répertoire principal
            this.watchDirectory(this.settings.syncFolderPath);
        } catch (error) {
            console.error('Erreur lors de la configuration de la surveillance de secours:', error);
            this.debugNotice(`Erreur de configuration de la surveillance de secours: ${error.message}`);
        }
    }

    watchDirectory(dirPath: string) {
        try {
            // Créer un observateur pour ce répertoire
            const watcher = fs.watch(dirPath, { recursive: false }, async (eventType, filename) => {
                if (!filename) return;
                
                // Si nous sommes déjà en train de traiter un changement externe, ignorer cet événement
                if (this.fileSync.getProcessingExternalChange()) {
                    this.debugLog(`Événement ignoré car déjà en train de traiter un changement externe: ${filename}`);
                    return;
                }
                
                // Construire le chemin complet du fichier modifié
                const fullPath = path.join(dirPath, filename);
                
                // Calculer le chemin relatif par rapport au répertoire de synchronisation
                const relativePath = path.relative(this.settings.syncFolderPath, fullPath).replace(/\\/g, '/');
                
                // Vérifier si le fichier est exclu
                if (this.fileSync.isExcluded(relativePath)) {
                    return;
                }
                
                this.debugLog(`Événement détecté (mode non récursif): ${eventType} pour le fichier ${relativePath}`);
                
                // Vérifier si le fichier existe et est un fichier (pas un répertoire)
                try {
                    const stats = await fsStat(fullPath);
                    
                    if (stats.isDirectory()) {
                        // Si c'est un répertoire, l'ajouter à la surveillance
                        if (!this.isDirectoryWatched(fullPath)) {
                            this.watchDirectory(fullPath);
                        }
                        return;
                    }
                    
                    this.debugLog(`Modification détectée pour le fichier externe: ${relativePath}`);
                    
                    // Attendre un court délai pour éviter de traiter des fichiers en cours d'écriture
                    setTimeout(() => {
                        this.fileSync.handleExternalFileChange(fullPath, relativePath);
                    }, 500);
                } catch (error) {
                    // Le fichier a peut-être été supprimé
                    if (eventType === 'rename') {
                        this.debugLog(`Suppression détectée pour le fichier externe: ${relativePath}`);
                        this.fileSync.handleExternalFileDeletion(relativePath);
                    }
                }
            });
            
            this.fileWatchers.push(watcher);
            
            // Parcourir les sous-répertoires et les surveiller aussi
            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const subDirPath = path.join(dirPath, entry.name);
                        const relativePath = path.relative(this.settings.syncFolderPath, subDirPath).replace(/\\/g, '/');
                        
                        // Ne pas surveiller les répertoires exclus
                        if (!this.fileSync.isExcluded(relativePath) && !this.isDirectoryWatched(subDirPath)) {
                            this.watchDirectory(subDirPath);
                        }
                    }
                }
            } catch (subDirError) {
                console.error(`Erreur lors de la surveillance des sous-répertoires de ${dirPath}:`, subDirError);
            }
        } catch (error) {
            console.error(`Erreur lors de la surveillance du répertoire ${dirPath}:`, error);
        }
    }
    
    isDirectoryWatched(dirPath: string): boolean {
        // Vérifier si ce répertoire est déjà surveillé
        // Cette fonction est utilisée pour éviter de surveiller plusieurs fois le même répertoire
        return false; // Pour l'instant, toujours surveiller pour être sûr
    }

    closeFileWatchers() {
        for (const watcher of this.fileWatchers) {
            watcher.close();
        }
        this.fileWatchers = [];
    }

    // Gérer le renommage d'un répertoire
    async handleFolderRename(folder: TFolder, oldPath: string) {
        try {
            this.debugLog(`Gestion du renommage de répertoire: ${oldPath} -> ${folder.path}`);
            
            // Construire les chemins externes
            const oldExternalPath = this.fileSync.getExternalPath(oldPath);
            const newExternalPath = this.fileSync.getExternalPath(folder.path);
            
            if (!oldExternalPath || !newExternalPath) {
                return;
            }
            
            // Vérifier si le répertoire source existe
            if (fs.existsSync(oldExternalPath)) {
                // Vérifier si le répertoire de destination existe déjà
                if (fs.existsSync(newExternalPath)) {
                    // Si le répertoire de destination existe déjà, fusionner le contenu
                    await this.moveDirectoryContents(oldExternalPath, newExternalPath);
                } else {
                    // Sinon, renommer simplement le répertoire
                    fs.renameSync(oldExternalPath, newExternalPath);
                    this.debugLog(`Répertoire externe renommé: ${oldExternalPath} -> ${newExternalPath}`);
                }
            } else {
                this.debugLog(`Répertoire source non trouvé: ${oldExternalPath}, création d'un nouveau répertoire`);
                
                // Créer le répertoire de destination s'il n'existe pas
                if (!fs.existsSync(newExternalPath)) {
                    fs.mkdirSync(newExternalPath, { recursive: true });
                    this.debugLog(`Nouveau répertoire créé: ${newExternalPath}`);
                }
            }
        } catch (error) {
            console.error(`Erreur lors du renommage du répertoire ${oldPath} -> ${folder.path}:`, error);
            this.debugNotice(`Erreur lors du renommage du répertoire: ${error.message}`);
        }
    }

    // Gérer la suppression d'un dossier
    async handleFolderDeletion(folderPath: string): Promise<void> {
        try {
            this.debugLog(`Gestion de la suppression du dossier: ${folderPath}`);
            
            // Vérifier si le dossier doit être synchronisé selon les paramètres
            if (!this.fileSync.shouldSyncFile(folderPath)) {
                this.debugLog(`Dossier ${folderPath} non inclus dans la synchronisation, ignoré`);
                return;
            }
            
            // Obtenir le chemin externe correspondant
            const externalPath = this.fileSync.getExternalPath(folderPath);
            if (!externalPath) {
                return;
            }
            
            // Vérifier si le répertoire externe existe
            if (fs.existsSync(externalPath)) {
                // Demander confirmation à l'utilisateur via une modal
                const modal = new ConfirmationModal(
                    this.app,
                    `Voulez-vous également supprimer le répertoire distant associé?\n${externalPath}`,
                    async (confirmed) => {
                        if (confirmed) {
                            try {
                                // Supprimer le répertoire externe de manière récursive
                                fs.rmdirSync(externalPath!, { recursive: true });
                                this.debugLog(`Répertoire externe supprimé: ${externalPath}`);
                                this.debugNotice(`Répertoire distant supprimé: ${externalPath}`);
                            } catch (error) {
                                console.error(`Erreur lors de la suppression du répertoire externe ${externalPath}:`, error);
                                this.debugNotice(`Erreur lors de la suppression du répertoire distant: ${error.message}`);
                            }
                        } else {
                            this.debugLog(`L'utilisateur a choisi de ne pas supprimer le répertoire distant: ${externalPath}`);
                        }
                    }
                );
                
                modal.open();
            } else {
                this.debugLog(`Répertoire externe non trouvé: ${externalPath}, aucune action nécessaire`);
            }
        } catch (error) {
            console.error(`Erreur lors de la gestion de la suppression du dossier ${folderPath}:`, error);
            this.debugNotice(`Erreur lors de la gestion de la suppression du dossier: ${error.message}`);
        }
    }

    // Déplacer un dossier vers la corbeille
    async moveFolderToTrash(folderPath: string) {
        try {
            // Vérifier si le dossier existe dans le vault
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            if (folder instanceof TFolder) {
                // Récupérer toutes les notes dans ce dossier et ses sous-dossiers
                const notesToTrash: TFile[] = [];
                this.getAllFilesInFolder(folder, notesToTrash);
                
                // Déplacer chaque note vers la corbeille individuellement
                for (const note of notesToTrash) {
                    try {
                        await this.app.vault.trash(note, true);
                        this.debugLog(`Note déplacée vers la corbeille: ${note.path}`);
                    } catch (noteError) {
                        console.error(`Erreur lors du déplacement de la note ${note.path} vers la corbeille:`, noteError);
                    }
                }
                
                // Déplacer le dossier lui-même vers la corbeille
                await this.app.vault.trash(folder, true);
                this.debugLog(`Dossier déplacé vers la corbeille: ${folderPath}`);
                this.debugNotice(`Dossier déplacé vers la corbeille: ${folderPath}`);
            } else {
                this.debugLog(`Dossier non trouvé dans le vault: ${folderPath}`);
            }
        } catch (error) {
            console.error(`Erreur lors du déplacement du dossier vers la corbeille ${folderPath}:`, error);
            this.debugNotice(`Erreur lors du déplacement vers la corbeille: ${error.message}`);
        }
    }
    
    // Récupérer toutes les notes dans un dossier et ses sous-dossiers
    private getAllFilesInFolder(folder: TFolder, files: TFile[]) {
        // Parcourir tous les éléments du dossier
        for (const child of folder.children) {
            if (child instanceof TFile) {
                // Ajouter le fichier à la liste
                files.push(child);
            } else if (child instanceof TFolder) {
                // Récursion pour les sous-dossiers
                this.getAllFilesInFolder(child, files);
            }
        }
    }

    // Déplacer le contenu d'un répertoire vers un autre
    async moveDirectoryContents(sourceDir: string, targetDir: string) {
        try {
            this.debug(`Déplacement du contenu: ${sourceDir} -> ${targetDir}`);
            
            // Créer le répertoire cible s'il n'existe pas
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            
            // Lire les entrées du répertoire source
            const entries = await fsReaddir(sourceDir, { withFileTypes: true });
            
            for (const entry of entries) {
                const sourcePath = path.join(sourceDir, entry.name);
                const targetPath = path.join(targetDir, entry.name);
                
                if (entry.isDirectory()) {
                    // Récursion pour les sous-répertoires
                    await this.moveDirectoryContents(sourcePath, targetPath);
                    
                    // Supprimer le répertoire source s'il est vide
                    try {
                        const remainingFiles = fs.readdirSync(sourcePath);
                        if (remainingFiles.length === 0) {
                            fs.rmdirSync(sourcePath);
                            this.debug(`Répertoire source vide supprimé: ${sourcePath}`);
                        }
                    } catch (error) {
                        console.error(`Erreur lors de la suppression du répertoire source: ${sourcePath}`, error);
                    }
                } else if (entry.isFile()) {
                    // Copier le fichier et supprimer l'original
                    fs.copyFileSync(sourcePath, targetPath);
                    fs.unlinkSync(sourcePath);
                    this.debug(`Fichier déplacé: ${sourcePath} -> ${targetPath}`);
                }
            }
        } catch (error) {
            console.error(`Erreur lors du déplacement des fichiers de ${sourceDir} vers ${targetDir}:`, error);
            throw error;
        }
    }

    // Vérifier si un répertoire a été renommé plutôt que supprimé
    async checkForRenamedDirectory(oldRelativePath: string): Promise<boolean> {
        try {
            // Cette méthode est une heuristique pour déterminer si un répertoire a été renommé
            // plutôt que supprimé. La détection précise est difficile car nous n'avons pas
            // d'événements directs de renommage de répertoire dans fs.watch.
            
            // Pour l'instant, nous supposons qu'il s'agit d'une suppression
            // Une amélioration future pourrait être de rechercher un nouveau répertoire
            // avec un contenu similaire qui est apparu récemment
            
            return false;
        } catch (error) {
            console.error(`Erreur lors de la vérification du renommage de répertoire: ${error}`);
            return false;
        }
    }
    
    // Obtenir la liste des répertoires dans le dossier de synchronisation
    async getExternalDirectories(): Promise<string[]> {
        if (!this.settings.syncFolderPath || !fs.existsSync(this.settings.syncFolderPath)) {
            return [];
        }
        
        const directories: string[] = [];
        
        const processDir = async (dir: string, relativePath: string = '') => {
            try {
                const entries = await fsReaddir(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                        directories.push(entryRelativePath);
                        
                        await processDir(path.join(dir, entry.name), entryRelativePath);
                    }
                }
            } catch (error) {
                console.error(`Erreur lors de la lecture du répertoire ${dir}:`, error);
            }
        };
        
        await processDir(this.settings.syncFolderPath);
        return directories;
    }

    async handleExternalDirectoryCreation(fullPath: string, relativePath: string) {
        try {
            this.debugLog(`Traitement de la création de répertoire externe: ${relativePath}`);
            
            // Vérifier si le répertoire doit être synchronisé selon les paramètres
            if (!this.fileSync.shouldSyncFile(relativePath)) {
                this.debugLog(`Répertoire ${relativePath} non inclus dans la synchronisation, ignoré`);
                return;
            }
            
            // Vérifier si le répertoire existe déjà dans le vault
            const existingDir = this.app.vault.getAbstractFileByPath(relativePath);
            
            if (!existingDir) {
                // Créer le répertoire dans le vault
                await this.fileSync.ensureVaultDirectory(relativePath);
                this.debugLog(`Répertoire créé dans le vault: ${relativePath}`);
                this.debugNotice(`Répertoire créé: ${relativePath}`);
            }
            
            // Synchroniser le contenu du répertoire
            await this.syncDirectoryFromExternal(fullPath, relativePath);
            
        } catch (error) {
            console.error(`Erreur lors de la création du répertoire ${relativePath}:`, error);
            this.debugNotice(`Erreur lors de la création du répertoire: ${error.message}`);
        }
    }
    
    // Gérer la suppression d'un répertoire externe
    async handleExternalDirectoryDeletion(relativePath: string) {
        try {
            this.debugLog(`Traitement de la suppression de répertoire externe: ${relativePath}`);
            
            // Vérifier si le répertoire doit être synchronisé selon les paramètres
            if (!this.fileSync.shouldSyncFile(relativePath)) {
                this.debugLog(`Répertoire ${relativePath} non inclus dans la synchronisation, ignoré`);
                return;
            }
            
            // Vérifier si le répertoire a été renommé plutôt que supprimé
            const wasRenamed = await this.checkForRenamedDirectory(relativePath);
            if (wasRenamed) {
                this.debugLog(`Le répertoire ${relativePath} a été renommé, pas de suppression nécessaire`);
                return;
            }
            
            // Vérifier si le répertoire existe dans le vault
            const existingDir = this.app.vault.getAbstractFileByPath(relativePath);
            
            if (existingDir instanceof TFolder) {
                // Déplacer le répertoire vers la corbeille au lieu de le supprimer
                await this.moveFolderToTrash(relativePath);
            }
            
        } catch (error) {
            console.error(`Erreur lors de la suppression du répertoire ${relativePath}:`, error);
            this.debugNotice(`Erreur lors de la suppression du répertoire: ${error.message}`);
        }
    }

    async syncDirectoryFromExternal(dirPath: string, relativeDirPath: string) {
        try {
            this.debugLog(`Synchronisation du répertoire externe vers le vault: ${relativeDirPath}`);
            
            // Vérifier si le répertoire doit être synchronisé selon les paramètres
            if (!this.fileSync.shouldSyncFile(relativeDirPath)) {
                this.debugLog(`Répertoire ${relativeDirPath} non inclus dans la synchronisation, ignoré`);
                return;
            }
            
            // Vérifier si le répertoire existe dans le vault
            const existingDir = this.app.vault.getAbstractFileByPath(relativeDirPath);
            
            // Si le répertoire n'existe pas dans le vault, le créer
            if (!existingDir) {
                await this.fileSync.ensureVaultDirectory(relativeDirPath);
                this.debugLog(`Répertoire créé dans le vault lors de la synchronisation: ${relativeDirPath}`);
                this.debugNotice(`Répertoire créé: ${relativeDirPath}`);
            }
            
            // Lire les fichiers et sous-répertoires du répertoire externe
            const entries = await fsReaddir(dirPath, { withFileTypes: true });
            
            // Si le répertoire est vide, on a déjà créé le dossier dans le vault, donc on peut retourner
            if (entries.length === 0) {
                this.debugLog(`Répertoire externe vide: ${dirPath}, dossier créé dans le vault: ${relativeDirPath}`);
                return;
            }
            
            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                const entryRelativePath = relativeDirPath ? path.join(relativeDirPath, entry.name) : entry.name;
                
                // Normaliser le chemin relatif pour utiliser des slashes avant
                const normalizedEntryRelativePath = entryRelativePath.replace(/\\/g, '/');
                
                // Vérifier si l'entrée doit être synchronisée selon les paramètres
                if (!this.fileSync.shouldSyncFile(normalizedEntryRelativePath)) {
                    this.debugLog(`Entrée ${normalizedEntryRelativePath} non incluse dans la synchronisation, ignorée`);
                    continue;
                }
                
                if (entry.isDirectory()) {
                    // Récursion pour les sous-répertoires
                    await this.syncDirectoryFromExternal(entryPath, normalizedEntryRelativePath);
                } else if (entry.isFile()) {
                    // Déterminer si le fichier est binaire en fonction de son extension
                    const isBinaryFile = this.fileSync.isBinaryFileType(normalizedEntryRelativePath);
                    
                    try {
                        if (isBinaryFile) {
                            // Lire le contenu binaire du fichier
                            const content = await fsReadFile(entryPath);
                            this.debugLog(`Contenu binaire lu depuis ${entryPath}, taille: ${content.length} octets`);
                            
                            const existingFile = this.app.vault.getAbstractFileByPath(normalizedEntryRelativePath);
                            
                            if (existingFile instanceof TFile) {
                                // Vérifier si le contenu est différent avant de mettre à jour
                                const currentContent = await this.app.vault.readBinary(existingFile);
                                const currentBuffer = Buffer.from(currentContent);
                                
                                if (!Buffer.from(content).equals(currentBuffer)) {
                                    await this.app.vault.modifyBinary(existingFile, content);
                                    this.debugLog(`Fichier binaire mis à jour lors de la synchronisation complète: ${normalizedEntryRelativePath}`);
                                    this.debugNotice(`Fichier binaire mis à jour: ${normalizedEntryRelativePath}`);
                                } else {
                                    this.debugLog(`Le contenu binaire est déjà à jour pour ${normalizedEntryRelativePath}`);
                                }
                            } else {
                                // Créer le répertoire parent si nécessaire
                                const parentDir = path.dirname(normalizedEntryRelativePath);
                                if (parentDir && parentDir !== '.') {
                                    await this.fileSync.ensureVaultDirectory(parentDir);
                                }
                                
                                try {
                                    await this.app.vault.createBinary(normalizedEntryRelativePath, content);
                                    this.debugLog(`Fichier binaire créé lors de la synchronisation complète: ${normalizedEntryRelativePath}`);
                                    this.debugNotice(`Fichier binaire créé: ${normalizedEntryRelativePath}`);
                                } catch (createError) {
                                    // Si l'erreur indique que le fichier existe déjà, essayer de le mettre à jour
                                    if (createError.message && createError.message.includes("already exists")) {
                                        // Attendre un court instant
                                        await new Promise(resolve => setTimeout(resolve, 200));
                                        // Récupérer à nouveau le fichier et le mettre à jour
                                        const fileAfterError = this.app.vault.getAbstractFileByPath(normalizedEntryRelativePath);
                                        if (fileAfterError instanceof TFile) {
                                            const currentContent = await this.app.vault.readBinary(fileAfterError);
                                            const currentBuffer = Buffer.from(currentContent);
                                            
                                            if (!Buffer.from(content).equals(currentBuffer)) {
                                                await this.app.vault.modifyBinary(fileAfterError, content);
                                                this.debugLog(`Fichier binaire mis à jour après erreur lors de la synchronisation complète: ${normalizedEntryRelativePath}`);
                                                this.debugNotice(`Fichier binaire mis à jour: ${normalizedEntryRelativePath}`);
                                            }
                                        }
                                    } else {
                                        throw createError;
                                    }
                                }
                            }
                        } else {
                            // Lire le contenu texte du fichier
                            const content = await fsReadFile(entryPath, 'utf8');
                            this.debugLog(`Contenu texte lu depuis ${entryPath}, longueur: ${content.length} caractères`);
                            
                            const existingFile = this.app.vault.getAbstractFileByPath(normalizedEntryRelativePath);
                            
                            if (existingFile instanceof TFile) {
                                // Vérifier si le contenu est différent avant de mettre à jour
                                const currentContent = await this.app.vault.read(existingFile);
                                if (currentContent !== content) {
                                    await this.app.vault.modify(existingFile, content);
                                    this.debugLog(`Fichier texte mis à jour lors de la synchronisation complète: ${normalizedEntryRelativePath}`);
                                    this.debugNotice(`Fichier texte mis à jour: ${normalizedEntryRelativePath}`);
                                } else {
                                    this.debugLog(`Le contenu texte est déjà à jour pour ${normalizedEntryRelativePath}`);
                                }
                            } else {
                                // Créer le répertoire parent si nécessaire
                                const parentDir = path.dirname(normalizedEntryRelativePath);
                                if (parentDir && parentDir !== '.') {
                                    await this.fileSync.ensureVaultDirectory(parentDir);
                                }
                                
                                try {
                                    await this.app.vault.create(normalizedEntryRelativePath, content);
                                    this.debugLog(`Fichier texte créé lors de la synchronisation complète: ${normalizedEntryRelativePath}`);
                                    this.debugNotice(`Fichier texte créé: ${normalizedEntryRelativePath}`);
                                } catch (createError) {
                                    // Si l'erreur indique que le fichier existe déjà, essayer de le mettre à jour
                                    if (createError.message && createError.message.includes("already exists")) {
                                        // Attendre un court instant
                                        await new Promise(resolve => setTimeout(resolve, 200));
                                        // Récupérer à nouveau le fichier et le mettre à jour
                                        const fileAfterError = this.app.vault.getAbstractFileByPath(normalizedEntryRelativePath);
                                        if (fileAfterError instanceof TFile) {
                                            const currentContent = await this.app.vault.read(fileAfterError);
                                            if (currentContent !== content) {
                                                await this.app.vault.modify(fileAfterError, content);
                                                this.debugLog(`Fichier texte mis à jour après erreur lors de la synchronisation complète: ${normalizedEntryRelativePath}`);
                                                this.debugNotice(`Fichier texte mis à jour: ${normalizedEntryRelativePath}`);
                                            }
                                        }
                                    } else {
                                        throw createError;
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`Erreur lors de la synchronisation du fichier ${normalizedEntryRelativePath}:`, error);
                    }
                }
            }
        } catch (error) {
            console.error(`Erreur lors de la synchronisation du répertoire ${dirPath}:`, error);
            throw error;
        }
    }

    // Fonction pour scanner récursivement tous les répertoires, y compris les vides
    async scanAndCreateAllDirectories(basePath: string, relativePath: string = '') {
        try {
            // Vérifier si le répertoire existe
            if (!fs.existsSync(basePath)) {
                this.debugLog(`Le répertoire n'existe pas: ${basePath}`);
                return;
            }
            
            // Créer le répertoire correspondant dans le vault si nécessaire
            if (relativePath) {
                const normalizedRelativePath = relativePath.replace(/\\/g, '/');
                
                // Vérifier si le répertoire doit être synchronisé selon les paramètres
                if (this.fileSync.shouldSyncFile(normalizedRelativePath)) {
                    // Vérifier si le répertoire existe dans le vault
                    const existingDir = this.app.vault.getAbstractFileByPath(normalizedRelativePath);
                    
                    // Si le répertoire n'existe pas dans le vault, le créer
                    if (!existingDir) {
                        await this.fileSync.ensureVaultDirectory(normalizedRelativePath);
                        this.debugLog(`Répertoire créé dans le vault: ${normalizedRelativePath}`);
                        this.debugNotice(`Répertoire créé: ${normalizedRelativePath}`);
                    }
                } else {
                    this.debugLog(`Répertoire ${normalizedRelativePath} non inclus dans la synchronisation, ignoré`);
                    return; // Ne pas explorer les sous-répertoires si le répertoire parent est exclu
                }
            }
            
            // Lire tous les éléments du répertoire
            const entries = await fsReaddir(basePath, { withFileTypes: true });
            
            // Parcourir tous les sous-répertoires
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const entryPath = path.join(basePath, entry.name);
                    const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
                    
                    // Récursion pour les sous-répertoires
                    await this.scanAndCreateAllDirectories(entryPath, entryRelativePath);
                }
            }
        } catch (error) {
            console.error(`Erreur lors du scan des répertoires: ${error}`);
            this.debugNotice(`Erreur lors du scan des répertoires: ${error.message}`);
        }
    }

    // Synchroniser tous les répertoires externes, y compris les répertoires vides
    async syncAllExternalDirectories() {
        if (!this.settings.syncFolderPath || !fs.existsSync(this.settings.syncFolderPath)) {
            this.debugLog('Répertoire de synchronisation non configuré ou inexistant');
            return;
        }

        try {
            // Étape 1: Scanner et créer tous les répertoires, y compris les vides
            this.debugLog('Étape 1: Création de la structure des répertoires');
            
            // Synchroniser le répertoire principal - structure des dossiers
            await this.scanAndCreateAllDirectories(this.settings.syncFolderPath);
            
            // Synchroniser les répertoires externes configurés - structure des dossiers
            for (const externalFolder of this.settings.externalIncludedFolders) {
                if (fs.existsSync(externalFolder)) {
                    // Calculer le chemin relatif par rapport au répertoire de synchronisation
                    const relativePath = path.relative(this.settings.syncFolderPath, externalFolder);
                    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
                    
                    // Synchroniser ce répertoire externe - structure des dossiers
                    this.debugLog(`Scan des répertoires externes: ${externalFolder}`);
                    await this.scanAndCreateAllDirectories(externalFolder, normalizedRelativePath || path.basename(externalFolder));
                } else {
                    this.debugLog(`Répertoire externe non trouvé: ${externalFolder}`);
                }
            }
            
            // Étape 2: Synchroniser les fichiers
            this.debugLog('Étape 2: Synchronisation des fichiers');
            
            // Synchroniser le répertoire principal - fichiers
            await this.syncDirectoryFromExternal(this.settings.syncFolderPath, '');
            
            // Synchroniser les répertoires externes configurés - fichiers
            for (const externalFolder of this.settings.externalIncludedFolders) {
                if (fs.existsSync(externalFolder)) {
                    // Calculer le chemin relatif par rapport au répertoire de synchronisation
                    const relativePath = path.relative(this.settings.syncFolderPath, externalFolder);
                    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
                    
                    // Synchroniser ce répertoire externe - fichiers
                    this.debugLog(`Synchronisation des fichiers du répertoire externe: ${externalFolder}`);
                    await this.syncDirectoryFromExternal(externalFolder, normalizedRelativePath || path.basename(externalFolder));
                }
            }
        } catch (error) {
            console.error('Erreur lors de la synchronisation des répertoires externes:', error);
            this.debugNotice(`Erreur lors de la synchronisation: ${error.message}`);
        }
    }
}
