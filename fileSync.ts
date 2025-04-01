import { App, Notice, TFile, TFolder, TAbstractFile, Modal, ButtonComponent } from 'obsidian';
import { SyncRepSettings } from './settings';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const fsReadFile = promisify(fs.readFile);
const fsWriteFile = promisify(fs.writeFile);
const fsReaddir = promisify(fs.readdir);
const fsStat = promisify(fs.stat);

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

export class FileSync {
    private app: App;
    private settings: SyncRepSettings;
    private isProcessingExternalChange = false;

    constructor(app: App, settings: SyncRepSettings) {
        this.app = app;
        this.settings = settings;
    }

    // Mettre à jour les paramètres
    updateSettings(settings: SyncRepSettings) {
        this.settings = settings;
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
        if (this.settings.debugMode) {
            console.log('[SyncRep]', ...args);
        }
    }

    // Déterminer si un fichier est binaire en fonction de son extension
    isBinaryFileType(filePath: string): boolean {
        const extension = path.extname(filePath).toLowerCase();
        const binaryExtensions = [
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp',  // Images
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',  // Documents
            '.zip', '.rar', '.7z', '.tar', '.gz',                       // Archives
            '.mp3', '.wav', '.ogg', '.flac', '.m4a',                    // Audio
            '.mp4', '.avi', '.mov', '.wmv', '.mkv', '.webm',            // Vidéo
            '.exe', '.dll', '.so', '.dylib',                            // Exécutables
            '.ttf', '.otf', '.woff', '.woff2',                          // Polices
        ];
        
        return binaryExtensions.includes(extension);
    }

    // Vérifier si un fichier doit être synchronisé selon les paramètres
    shouldSyncFile(filePath: string): boolean {
        // Si nous sommes en mode de synchronisation "all", synchroniser tous les fichiers sauf ceux exclus
        if (this.settings.syncMode === 'all') {
            return !this.isExcluded(filePath);
        }
        
        // En mode "include", synchroniser uniquement les fichiers dans les dossiers inclus
        return this.isIncluded(filePath) || this.isExternalIncluded(filePath);
    }
    
    // Vérifier si un fichier est dans un dossier inclus
    isIncluded(filePath: string): boolean {
        // Vérifier si le fichier est dans un dossier inclus
        for (const includedFolder of this.settings.includedFolders) {
            // Si le dossier inclus est la racine, tous les fichiers sont inclus
            if (includedFolder === '') {
                return true;
            }
            
            // Vérifier si le fichier est dans ce dossier inclus
            if (filePath === includedFolder || filePath.startsWith(includedFolder + '/')) {
                return true;
            }
        }
        
        return false;
    }
    
    // Vérifier si un fichier est dans un dossier externe inclus
    isExternalIncluded(filePath: string): boolean {
        // Vérifier si le fichier est dans un des dossiers externes configurés
        for (const externalFolder of this.settings.externalIncludedFolders) {
            const folderName = path.basename(externalFolder);
            
            if (filePath === folderName || filePath.startsWith(folderName + '/')) {
                return true;
            }
        }
        
        return false;
    }

    isExcluded(filePath: string): boolean {
        return this.settings.excludedFolders.some(folder => 
            filePath === folder || 
            filePath.startsWith(folder + '/') || 
            filePath.startsWith(folder + '\\')
        );
    }

    async handleExternalFileChange(fullPath: string, relativePath: string) {
        try {
            this.debug(`Traitement du changement de fichier externe: ${relativePath}`);
            this.isProcessingExternalChange = true;

            // Vérifier si le fichier doit être synchronisé selon les paramètres
            if (!this.shouldSyncFile(relativePath)) {
                this.debug(`Fichier ${relativePath} non inclus dans la synchronisation, ignoré`);
                return;
            }

            // Déterminer le chemin dans le vault
            let vaultPath = relativePath;
            
            // Vérifier si le fichier est dans un répertoire externe configuré
            for (const externalFolder of this.settings.externalIncludedFolders) {
                if (fullPath.startsWith(externalFolder)) {
                    // Obtenir le nom du dossier externe
                    const folderName = path.basename(externalFolder);
                    
                    // Créer le nom du dossier dans le vault
                    const vaultFolderName = folderName;
                    
                    // Calculer le chemin relatif du fichier par rapport au dossier externe
                    const relativeToExternal = path.relative(externalFolder, fullPath);
                    
                    // Construire le chemin dans le vault
                    vaultPath = relativeToExternal ? 
                        path.join(vaultFolderName, relativeToExternal).replace(/\\/g, '/') : 
                        vaultFolderName;
                    
                    this.debug(`Fichier externe détecté: ${fullPath} -> ${vaultPath}`);
                    break;
                }
            }

            // Vérifier si le fichier existe dans le vault
            const existingFile = this.app.vault.getAbstractFileByPath(vaultPath);

            // Déterminer si le fichier est binaire en fonction de son extension
            const isBinaryFile = this.isBinaryFileType(vaultPath);

            try {
                if (isBinaryFile) {
                    // Lire le contenu binaire du fichier
                    const content = await fsReadFile(fullPath);
                    this.debug(`Contenu binaire lu depuis ${fullPath}, taille: ${content.length} octets`);
                    
                    if (existingFile instanceof TFile) {
                        // Vérifier si le contenu est différent avant de mettre à jour
                        const currentContent = await this.app.vault.readBinary(existingFile);
                        const currentBuffer = Buffer.from(currentContent);
                        
                        if (!Buffer.from(content).equals(currentBuffer)) {
                            await this.app.vault.modifyBinary(existingFile, content);
                            this.debug(`Fichier binaire mis à jour: ${vaultPath}`);
                            this.debugNotice(`Fichier binaire mis à jour: ${vaultPath}`);
                        } else {
                            this.debug(`Le contenu binaire est déjà à jour pour ${vaultPath}`);
                        }
                    } else {
                        // Créer le répertoire parent si nécessaire
                        const parentDir = path.dirname(vaultPath);
                        if (parentDir && parentDir !== '.') {
                            await this.ensureVaultDirectory(parentDir);
                        }
                        
                        try {
                            await this.app.vault.createBinary(vaultPath, content);
                            this.debug(`Fichier binaire créé: ${vaultPath}`);
                            this.debugNotice(`Fichier binaire créé: ${vaultPath}`);
                        } catch (createError) {
                            // Si l'erreur indique que le fichier existe déjà, essayer de le mettre à jour
                            if (createError.message && createError.message.includes("already exists")) {
                                // Attendre un court instant
                                await new Promise(resolve => setTimeout(resolve, 200));
                                // Récupérer à nouveau le fichier et le mettre à jour
                                const fileAfterError = this.app.vault.getAbstractFileByPath(vaultPath);
                                if (fileAfterError instanceof TFile) {
                                    const currentContent = await this.app.vault.readBinary(fileAfterError);
                                    const currentBuffer = Buffer.from(currentContent);
                                    
                                    if (!Buffer.from(content).equals(currentBuffer)) {
                                        await this.app.vault.modifyBinary(fileAfterError, content);
                                        this.debug(`Fichier binaire mis à jour après erreur: ${vaultPath}`);
                                        this.debugNotice(`Fichier binaire mis à jour: ${vaultPath}`);
                                    }
                                }
                            } else {
                                throw createError;
                            }
                        }
                    }
                } else {
                    // Lire le contenu texte du fichier
                    const content = await fsReadFile(fullPath, 'utf8');
                    this.debug(`Contenu texte lu depuis ${fullPath}, longueur: ${content.length} caractères`);
                    
                    if (existingFile instanceof TFile) {
                        // Vérifier si le contenu est différent avant de mettre à jour
                        const currentContent = await this.app.vault.read(existingFile);
                        if (currentContent !== content) {
                            await this.app.vault.modify(existingFile, content);
                            this.debug(`Fichier texte mis à jour: ${vaultPath}`);
                            this.debugNotice(`Fichier texte mis à jour: ${vaultPath}`);
                        } else {
                            this.debug(`Le contenu texte est déjà à jour pour ${vaultPath}`);
                        }
                    } else {
                        // Créer le répertoire parent si nécessaire
                        const parentDir = path.dirname(vaultPath);
                        if (parentDir && parentDir !== '.') {
                            await this.ensureVaultDirectory(parentDir);
                        }
                        
                        try {
                            await this.app.vault.create(vaultPath, content);
                            this.debug(`Fichier texte créé: ${vaultPath}`);
                            this.debugNotice(`Fichier texte créé: ${vaultPath}`);
                        } catch (createError) {
                            // Si l'erreur indique que le fichier existe déjà, essayer de le mettre à jour
                            if (createError.message && createError.message.includes("already exists")) {
                                // Attendre un court instant
                                await new Promise(resolve => setTimeout(resolve, 200));
                                // Récupérer à nouveau le fichier et le mettre à jour
                                const fileAfterError = this.app.vault.getAbstractFileByPath(vaultPath);
                                if (fileAfterError instanceof TFile) {
                                    const currentContent = await this.app.vault.read(fileAfterError);
                                    if (currentContent !== content) {
                                        await this.app.vault.modify(fileAfterError, content);
                                        this.debug(`Fichier texte mis à jour après erreur: ${vaultPath}`);
                                        this.debugNotice(`Fichier texte mis à jour: ${vaultPath}`);
                                    }
                                }
                            } else {
                                throw createError;
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`Erreur lors du traitement du fichier ${fullPath}:`, error);
                this.debugNotice(`Erreur lors du traitement du fichier: ${error.message}`);
            }
        } catch (error) {
            console.error(`Erreur lors de la gestion du changement de fichier externe ${fullPath}:`, error);
            this.debugNotice(`Erreur lors de la gestion du changement de fichier: ${error.message}`);
        } finally {
            this.isProcessingExternalChange = false;
        }
    }

    async handleExternalFileDeletion(relativePath: string) {
        try {
            this.debug(`Traitement de la suppression de fichier externe: ${relativePath}`);
            this.isProcessingExternalChange = true;

            // Vérifier si le fichier doit être synchronisé selon les paramètres
            if (!this.shouldSyncFile(relativePath)) {
                this.debug(`Fichier ${relativePath} non inclus dans la synchronisation, suppression ignorée`);
                return;
            }

            // Vérifier si le fichier existe dans le vault
            const existingFile = this.app.vault.getAbstractFileByPath(relativePath);

            if (existingFile instanceof TFile) {
                // Déplacer le fichier vers la corbeille
                await this.moveFileToTrash(relativePath);
            } else {
                this.debug(`Fichier ${relativePath} non trouvé dans le vault, rien à supprimer`);
            }
        } catch (error) {
            console.error(`Erreur lors de la suppression du fichier ${relativePath}:`, error);
            this.debugNotice(`Erreur de suppression: ${error.message}`);
        } finally {
            // Réinitialiser le drapeau après un délai
            setTimeout(() => {
                this.isProcessingExternalChange = false;
                this.debug(`Fin du traitement de la suppression pour ${relativePath}`);
            }, 500);
        }
    }

    async syncFile(file: TFile) {
        try {
            // Vérifier si le fichier doit être synchronisé selon les paramètres
            if (!this.shouldSyncFile(file.path)) {
                this.debug(`Fichier ${file.path} non inclus dans la synchronisation, ignoré`);
                return;
            }
            
            // Obtenir le chemin de destination externe
            const destPath = this.getExternalPath(file.path);
            if (!destPath) {
                return;
            }
            
            // Créer le répertoire parent si nécessaire
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
                this.debug(`Répertoire créé: ${destDir}`);
            }
            
            // Déterminer si le fichier est binaire en fonction de son extension
            const isBinaryFile = this.isBinaryFileType(file.path);
            
            if (isBinaryFile) {
                // Lire le contenu binaire du fichier
                const content = await this.app.vault.readBinary(file);
                
                // Écrire le contenu dans le fichier externe
                await fsWriteFile(destPath, Buffer.from(content));
                this.debug(`Fichier binaire synchronisé: ${file.path} -> ${destPath}`);
            } else {
                // Lire le contenu du fichier
                const content = await this.app.vault.read(file);
                
                // Écrire le contenu dans le fichier externe
                await fsWriteFile(destPath, content, 'utf8');
                this.debug(`Fichier texte synchronisé: ${file.path} -> ${destPath}`);
            }
        } catch (error) {
            console.error(`Erreur lors de la synchronisation du fichier ${file.path}:`, error);
            this.debugNotice(`Erreur lors de la synchronisation: ${error.message}`);
        }
    }

    async handleFileDeletion(filePath: string) {
        try {
            // Obtenir le chemin externe correspondant
            const externalPath = this.getExternalPath(filePath);
            if (!externalPath) {
                return;
            }
            
            // Vérifier si le fichier externe existe
            if (fs.existsSync(externalPath)) {
                // Demander confirmation à l'utilisateur via une modal
                const modal = new ConfirmationModal(
                    this.app,
                    `Voulez-vous également supprimer le fichier distant associé?\n${externalPath}`,
                    async (confirmed) => {
                        if (confirmed) {
                            try {
                                // Supprimer le fichier externe
                                fs.unlinkSync(externalPath);
                                this.debug(`Fichier externe supprimé: ${externalPath}`);
                                this.debugNotice(`Fichier distant supprimé: ${externalPath}`);
                            } catch (error) {
                                console.error(`Erreur lors de la suppression du fichier externe ${externalPath}:`, error);
                                this.debugNotice(`Erreur lors de la suppression du fichier distant: ${error.message}`);
                            }
                        } else {
                            this.debug(`L'utilisateur a choisi de ne pas supprimer le fichier distant: ${externalPath}`);
                        }
                    }
                );
                
                modal.open();
            }
        } catch (error) {
            console.error(`Erreur lors de la suppression du fichier externe ${filePath}:`, error);
        }
    }

    async ensureVaultDirectory(dirPath: string) {
        const dirs = dirPath.split('/');
        let currentPath = '';
        
        for (const dir of dirs) {
            currentPath = currentPath ? `${currentPath}/${dir}` : dir;
            const existingDir = this.app.vault.getAbstractFileByPath(currentPath);
            
            if (!existingDir) {
                try {
                    await this.app.vault.createFolder(currentPath);
                } catch (error) {
                    // Ignorer l'erreur si le dossier existe déjà
                    if (!error.message || !error.message.includes("already exists")) {
                        throw error;
                    }
                    this.debug(`Le dossier ${currentPath} existe déjà, continuation...`);
                }
            }
        }
    }

    setProcessingExternalChange(value: boolean) {
        this.isProcessingExternalChange = value;
    }

    getProcessingExternalChange(): boolean {
        return this.isProcessingExternalChange;
    }

    // Utilitaire pour construire le chemin de destination externe
    getExternalPath(vaultPath: string): string | undefined {
        if (!this.settings.syncFolderPath) {
            this.debug("Chemin de synchronisation non configuré");
            return undefined;
        }
        
        // Vérifier si le chemin est dans un dossier externe inclus
        for (const externalFolder of this.settings.externalIncludedFolders) {
            const folderName = path.basename(externalFolder);
            
            if (vaultPath === folderName || vaultPath.startsWith(folderName + '/')) {
                // Calculer le chemin relatif du fichier par rapport à son dossier parent
                const relativeToParent = vaultPath.substring(folderName.length + 1); // +1 pour le séparateur
                
                // Construire le chemin de destination dans le dossier externe
                return path.join(externalFolder, relativeToParent);
            }
        }
        
        // Chemin standard dans le répertoire de synchronisation
        return path.join(this.settings.syncFolderPath, vaultPath);
    }

    // Synchroniser les fichiers depuis un répertoire externe
    async syncFromExternal(externalPath: string): Promise<void> {
        try {
            this.debug(`Synchronisation depuis le répertoire externe: ${externalPath}`);
            
            // Vérifier si le répertoire externe existe
            if (!fs.existsSync(externalPath)) {
                this.debug(`Le répertoire externe n'existe pas: ${externalPath}`);
                return;
            }
            
            // Lire récursivement tous les fichiers du répertoire externe
            const files = await this.readFilesRecursively(externalPath);
            
            // Obtenir le nom du dossier
            const folderName = path.basename(externalPath);
            
            // Créer le nom du dossier dans le vault
            const vaultFolderName = folderName;
            
            // Créer le dossier dans le vault s'il n'existe pas
            const existingFolder = this.app.vault.getAbstractFileByPath(vaultFolderName);
            if (!existingFolder) {
                try {
                    await this.app.vault.createFolder(vaultFolderName);
                    this.debug(`Dossier créé dans le vault: ${vaultFolderName}`);
                } catch (error) {
                    console.error(`Erreur lors de la création du dossier ${vaultFolderName}:`, error);
                    this.debugNotice(`Erreur lors de la création du dossier: ${error.message}`);
                    return;
                }
            }
            
            // Synchroniser chaque fichier
            for (const file of files) {
                try {
                    // Calculer le chemin relatif du fichier par rapport au répertoire externe
                    const relativePath = path.relative(externalPath, file);
                    
                    // Construire le chemin dans le vault
                    const vaultPath = path.join(vaultFolderName, relativePath).replace(/\\/g, '/');
                    
                    // Vérifier si le fichier existe dans le vault
                    const existingFile = this.app.vault.getAbstractFileByPath(vaultPath);
                    
                    // Déterminer si le fichier est binaire
                    const isBinaryFile = this.isBinaryFileType(file);
                    
                    if (isBinaryFile) {
                        // Lire le contenu binaire du fichier
                        const content = await fsReadFile(file);
                        
                        if (existingFile instanceof TFile) {
                            // Vérifier si le contenu est différent avant de mettre à jour
                            const currentContent = await this.app.vault.readBinary(existingFile);
                            const currentBuffer = Buffer.from(currentContent);
                            
                            if (!Buffer.from(content).equals(currentBuffer)) {
                                await this.app.vault.modifyBinary(existingFile, content);
                                this.debug(`Fichier binaire mis à jour: ${vaultPath}`);
                            } else {
                                this.debug(`Le contenu binaire est déjà à jour pour ${vaultPath}`);
                            }
                        } else {
                            // Créer le répertoire parent si nécessaire
                            const parentDir = path.dirname(vaultPath);
                            if (parentDir && parentDir !== '.') {
                                await this.ensureVaultDirectory(parentDir);
                            }
                            
                            await this.app.vault.createBinary(vaultPath, content);
                            this.debug(`Fichier binaire créé: ${vaultPath}`);
                        }
                    } else {
                        // Lire le contenu texte du fichier
                        const content = await fsReadFile(file, 'utf8');
                        
                        if (existingFile instanceof TFile) {
                            // Vérifier si le contenu est différent avant de mettre à jour
                            const currentContent = await this.app.vault.read(existingFile);
                            if (currentContent !== content) {
                                await this.app.vault.modify(existingFile, content);
                                this.debug(`Fichier texte mis à jour: ${vaultPath}`);
                            } else {
                                this.debug(`Le contenu texte est déjà à jour pour ${vaultPath}`);
                            }
                        } else {
                            // Créer le répertoire parent si nécessaire
                            const parentDir = path.dirname(vaultPath);
                            if (parentDir && parentDir !== '.') {
                                await this.ensureVaultDirectory(parentDir);
                            }
                            
                            await this.app.vault.create(vaultPath, content);
                            this.debug(`Fichier texte créé: ${vaultPath}`);
                        }
                    }
                } catch (error) {
                    console.error(`Erreur lors de la synchronisation du fichier ${file}:`, error);
                    this.debugNotice(`Erreur lors de la synchronisation: ${error.message}`);
                }
            }
            
            this.debug(`Synchronisation terminée pour le répertoire externe: ${externalPath}`);
            
        } catch (error) {
            console.error(`Erreur lors de la synchronisation depuis le répertoire externe ${externalPath}:`, error);
            this.debugNotice(`Erreur lors de la synchronisation: ${error.message}`);
        }
    }
    
    // Lire récursivement tous les fichiers d'un répertoire
    private async readFilesRecursively(dir: string): Promise<string[]> {
        const files: string[] = [];
        
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    // Récursion pour les sous-répertoires
                    const subFiles = await this.readFilesRecursively(fullPath);
                    files.push(...subFiles);
                } else if (entry.isFile()) {
                    files.push(fullPath);
                }
            }
        } catch (error) {
            console.error(`Erreur lors de la lecture récursive du répertoire ${dir}:`, error);
        }
        
        return files;
    }

    // Synchroniser un dossier vers le répertoire externe
    async syncFolder(folder: TFolder): Promise<void> {
        try {
            // Vérifier si le dossier doit être synchronisé selon les paramètres
            if (!this.shouldSyncFile(folder.path)) {
                this.debug(`Dossier ${folder.path} non inclus dans la synchronisation, ignoré`);
                return;
            }
            
            // Obtenir le chemin de destination externe
            const destPath = this.getExternalPath(folder.path);
            if (!destPath) {
                return;
            }
            
            // Créer le répertoire de destination s'il n'existe pas
            if (!fs.existsSync(destPath)) {
                fs.mkdirSync(destPath, { recursive: true });
                this.debug(`Dossier externe créé: ${destPath}`);
                this.debugNotice(`Dossier synchronisé: ${folder.path}`);
            } else {
                this.debug(`Dossier externe existe déjà: ${destPath}`);
            }
        } catch (error) {
            console.error(`Erreur lors de la synchronisation du dossier ${folder.path}:`, error);
            this.debugNotice(`Erreur lors de la synchronisation du dossier: ${error.message}`);
        }
    }

    // Déplacer un fichier vers la corbeille
    async moveFileToTrash(filePath: string) {
        try {
            // Vérifier si le fichier existe dans le vault
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file) {
                // Déplacer le fichier vers la corbeille
                await this.app.vault.trash(file, true);
                this.debug(`Fichier déplacé vers la corbeille: ${filePath}`);
                this.debugNotice(`Fichier déplacé vers la corbeille: ${filePath}`);
            } else {
                this.debug(`Fichier non trouvé dans le vault: ${filePath}`);
            }
        } catch (error) {
            console.error(`Erreur lors du déplacement du fichier vers la corbeille ${filePath}:`, error);
            this.debugNotice(`Erreur lors du déplacement vers la corbeille: ${error.message}`);
        }
    }

    // Gérer le renommage d'un fichier
    async handleFileRename(oldPath: string, newPath: string) {
        try {
            // Obtenir les chemins externes correspondants
            const oldExternalPath = this.getExternalPath(oldPath);
            const newExternalPath = this.getExternalPath(newPath);
            
            if (!oldExternalPath || !newExternalPath) {
                return;
            }
            
            // Vérifier si le fichier externe existe
            if (fs.existsSync(oldExternalPath)) {
                // Créer le répertoire parent du nouveau chemin si nécessaire
                const newParentDir = path.dirname(newExternalPath);
                if (!fs.existsSync(newParentDir)) {
                    fs.mkdirSync(newParentDir, { recursive: true });
                    this.debug(`Répertoire parent créé: ${newParentDir}`);
                }
                
                // Renommer le fichier au lieu de le supprimer
                fs.renameSync(oldExternalPath, newExternalPath);
                this.debug(`Fichier externe renommé: ${oldExternalPath} -> ${newExternalPath}`);
                
                return true; // Indique que le renommage a été effectué
            } else {
                this.debug(`Fichier source non trouvé: ${oldExternalPath}, le renommage sera ignoré`);
                return false; // Indique que le renommage n'a pas été effectué
            }
        } catch (error) {
            console.error(`Erreur lors du renommage du fichier externe ${oldPath} -> ${newPath}:`, error);
            return false;
        }
    }
}
