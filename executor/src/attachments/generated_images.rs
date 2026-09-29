// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Durable, content-addressed image attachments. The index contains no model output.

use std::{
    fs,
    io::{Cursor, Write},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use base64::Engine;
use image::{GenericImageView, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::device_runtime_attachment_task_dir;
use crate::agents::runtime_capabilities::workspace_root;

pub(crate) const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const IMAGE_DIRECTORY: &str = "outputs/generated-images";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ImageArtifact {
    pub workspace_path: String,
    pub relative_path: String,
    pub mime_type: String,
    pub size: u64,
    pub width: u32,
    pub height: u32,
}

impl ImageArtifact {
    pub(crate) fn saved_path(&self) -> PathBuf {
        Path::new(&self.workspace_path).join(&self.relative_path)
    }
}

pub(crate) fn canonical_workspace(workspace: &str) -> Result<PathBuf, String> {
    canonical_workspace_with_root(workspace, &workspace_root())
}

fn canonical_workspace_with_root(workspace: &str, root: &Path) -> Result<PathBuf, String> {
    if workspace.trim().is_empty() {
        return Err("Task workspace path is unavailable".into());
    }
    let path = expand_home_path(workspace)?;
    if path.is_absolute() {
        return path
            .canonicalize()
            .map_err(|e| format!("Failed to resolve task workspace: {e}"));
    }
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("Relative task workspace path contains unsupported components".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("Task workspace escapes the executor workspace root".into());
    }
    Ok(path)
}

fn expand_home_path(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        return dirs::home_dir()
            .map(|home| home.join(path.get(2..).unwrap_or_default()))
            .ok_or_else(|| "Home directory is unavailable".into());
    }
    Ok(PathBuf::from(path))
}

pub(crate) fn materialize_generated_image(
    saved_path: &str,
    workspace: &str,
) -> Result<ImageArtifact, String> {
    let workspace = canonical_workspace(workspace)?;
    let source = expand_home_path(saved_path)?;
    let source = if source.is_absolute() {
        source
    } else {
        workspace.join(source)
    };
    let file =
        fs::File::open(&source).map_err(|e| format!("Failed to open generated image: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Generated image source is not a file".into());
    }
    // Bound the read even if the file grows after metadata was inspected.
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read generated image: {e}"))?;
    save_image_bytes(&bytes, &workspace)
}

pub(crate) fn save_base64_image(encoded: &str, workspace: &str) -> Result<ImageArtifact, String> {
    if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("Generated image exceeds the 50 MiB limit".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Generated image contains invalid Base64".to_owned())?;
    save_image_bytes(&bytes, &canonical_workspace(workspace)?)
}

fn save_image_bytes(bytes: &[u8], workspace: &Path) -> Result<ImageArtifact, String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Generated image exceeds the 50 MiB limit".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "Generated image format is invalid")?;
    let (extension, mime_type) = match format {
        image::ImageFormat::Png => ("png", "image/png"),
        image::ImageFormat::Jpeg => ("jpg", "image/jpeg"),
        image::ImageFormat::WebP => ("webp", "image/webp"),
        image::ImageFormat::Gif => ("gif", "image/gif"),
        image::ImageFormat::Bmp => ("bmp", "image/bmp"),
        _ => return Err("Generated image uses an unsupported file type".into()),
    };
    // ImageReader's allocation limits apply to the full decode, not just the header.
    let decoded = ImageReader::with_format(Cursor::new(bytes), format)
        .decode()
        .map_err(|e| format!("Generated image data is invalid: {e}"))?;
    let (width, height) = decoded.dimensions();
    if width == 0 || height == 0 {
        return Err("Generated image dimensions are invalid".into());
    }
    let mut directory = workspace.to_path_buf();
    for component in IMAGE_DIRECTORY.split('/') {
        directory.push(component);
        fs::create_dir_all(&directory)
            .map_err(|e| format!("Failed to create image directory: {e}"))?;
        directory = directory.canonicalize().map_err(|e| e.to_string())?;
        if !directory.starts_with(workspace) {
            return Err("Generated image directory escapes the task workspace".into());
        }
    }
    let filename = format!("{:x}.{extension}", Sha256::digest(bytes));
    // Always replace atomically: an existing file may be corrupt or a symlink.
    atomic_write(&directory.join(&filename), bytes)?;
    Ok(ImageArtifact {
        workspace_path: workspace.display().to_string(),
        relative_path: format!("{IMAGE_DIRECTORY}/{filename}"),
        mime_type: mime_type.into(),
        size: bytes.len() as u64,
        width,
        height,
    })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or("Image artifact has no parent directory")?;
    fs::create_dir_all(directory).map_err(|e| format!("Failed to create image storage: {e}"))?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| format!("Failed to save generated image: {e}"))?;
    file.persist(path)
        .map_err(|e| format!("Failed to publish generated image: {e}"))?;
    #[cfg(unix)]
    fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct GeneratedImageDelivery {
    pub thread_id: String,
    pub turn_id: String,
    pub root_thread_id: String,
    pub root_turn_id: String,
    pub image_id: String,
    pub created_at: i64,
    pub artifact: Option<ImageArtifact>,
    pub error: Option<String>,
}

impl GeneratedImageDelivery {
    pub(crate) fn item(&self) -> Value {
        json!({
            "id": self.image_id,
            "type": "imageGeneration",
            "status": if self.error.is_some() { "failed" } else { "completed" },
            "savedPath": self.artifact.as_ref().map(ImageArtifact::saved_path),
            "deliveryError": self.error,
            "createdAt": self.created_at,
            "threadId": self.thread_id,
            "imageSourceThreadId": self.thread_id,
            "imageSourceTurnId": self.turn_id,
            "imageRootThreadId": self.root_thread_id,
            "imageRootTurnId": self.root_turn_id,
        })
    }
}

pub(crate) fn index_path(task_id: &str) -> PathBuf {
    device_runtime_attachment_task_dir(task_id).join("generated-images/index.json")
}

fn index_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_index(path: &Path) -> Result<Vec<GeneratedImageDelivery>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid image index: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Failed to read generated image index: {e}")),
    }
}

pub(crate) fn persist_delivery_at(
    path: &Path,
    delivery: &GeneratedImageDelivery,
) -> Result<GeneratedImageDelivery, String> {
    let _guard = index_lock()
        .lock()
        .map_err(|_| "Generated image index lock failed")?;
    let mut entries = read_index(path)?;
    let canonical = if let Some(existing) = entries.iter_mut().find(|entry| {
        entry.thread_id == delivery.thread_id
            && entry.turn_id == delivery.turn_id
            && entry.image_id == delivery.image_id
    }) {
        // A replay must not erase a delivered file or move it into another turn.
        if existing.artifact.is_some() && existing.error.is_none() {
            return Ok(existing.clone());
        }
        existing.artifact = delivery.artifact.clone();
        existing.error = delivery.error.clone();
        existing.clone()
    } else {
        entries.push(delivery.clone());
        delivery.clone()
    };
    atomic_write(
        path,
        &serde_json::to_vec(&entries).map_err(|e| e.to_string())?,
    )?;
    Ok(canonical)
}

/// Merge only turns on this page. Never synthesize turns outside pagination.
pub(crate) fn merge_thread_images(task_id: &str, thread: &mut Value) -> Result<(), String> {
    merge_entries(&read_index(&index_path(task_id))?, thread);
    Ok(())
}

fn merge_entries(entries: &[GeneratedImageDelivery], thread: &mut Value) {
    let thread_id = thread["id"].as_str().unwrap_or_default().to_owned();
    let Some(turns) = thread["turns"].as_array_mut() else {
        return;
    };
    for turn in turns {
        let turn_id = turn["id"].as_str().unwrap_or_default().to_owned();
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
            continue;
        };
        for delivery in entries
            .iter()
            .filter(|entry| entry.thread_id == thread_id && entry.turn_id == turn_id)
        {
            let item = delivery.item();
            if let Some(existing) = items
                .iter_mut()
                .find(|item| item["id"] == delivery.image_id)
            {
                *existing = item;
            } else {
                items.push(item);
            }
        }
    }
}

/// Enrich later native notifications so a path-less item cannot erase delivery.
pub(crate) fn enrich_notification(task_id: &str, message: &mut Value) {
    if message.pointer("/params/item/type").and_then(Value::as_str) != Some("imageGeneration") {
        return;
    }
    let Ok(entries) = read_index(&index_path(task_id)) else {
        return;
    };
    enrich_from_entries(&entries, message);
}

fn enrich_from_entries(entries: &[GeneratedImageDelivery], message: &mut Value) {
    let params = &message["params"];
    let found = entries.iter().find(|entry| {
        params["item"]["id"] == entry.image_id
            && params["threadId"] == entry.thread_id
            && params["turnId"] == entry.turn_id
    });
    if let Some(entry) = found {
        message["params"]["item"] = entry.item();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn png_base64() -> String {
        let mut bytes = Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(4, 2, image::Rgba([0, 0, 255, 255]))
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    }

    fn delivery(id: &str, turn: &str) -> GeneratedImageDelivery {
        GeneratedImageDelivery {
            thread_id: "child".into(),
            turn_id: turn.into(),
            root_thread_id: "root".into(),
            root_turn_id: "root-turn".into(),
            image_id: id.into(),
            created_at: 123,
            artifact: None,
            error: Some("test failure".into()),
        }
    }

    #[test]
    fn generated_images_are_validated_and_content_addressed() {
        let workspace = tempfile::tempdir().unwrap();
        let encoded = png_base64();
        let image = save_base64_image(&encoded, workspace.path().to_str().unwrap()).unwrap();
        assert_eq!((image.width, image.height), (4, 2));
        assert!(image.saved_path().is_file());
        assert_eq!(image.mime_type, "image/png");
        let second = materialize_generated_image(
            image.saved_path().to_str().unwrap(),
            workspace.path().to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(image.relative_path, second.relative_path);
        assert_eq!(
            fs::read_dir(image.saved_path().parent().unwrap())
                .unwrap()
                .count(),
            1
        );
        assert!(!serde_json::to_string(&image).unwrap().contains(&encoded));
    }

    #[test]
    fn rejects_invalid_base64_corrupt_pixels_and_oversized_images() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().to_str().unwrap();
        assert!(save_base64_image("@@@", path)
            .unwrap_err()
            .contains("Base64"));
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(png_base64())
            .unwrap();
        bytes.truncate(40); // Retains a valid header and dimensions, but not pixels.
        assert!(save_image_bytes(&bytes, workspace.path()).is_err());
        assert!(
            save_base64_image(&"a".repeat(MAX_IMAGE_BYTES.div_ceil(3) * 4 + 1), path)
                .unwrap_err()
                .contains("50 MiB")
        );
        assert!(materialize_generated_image("missing.png", path).is_err());
    }

    #[test]
    fn rejects_unwritable_output_directory() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("outputs"), b"not a directory").unwrap();
        assert!(save_base64_image(&png_base64(), workspace.path().to_str().unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_escaping_output_symlinks_and_replaces_file_symlinks() {
        use std::os::unix::fs::symlink;
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), workspace.path().join("outputs")).unwrap();
        assert!(save_base64_image(&png_base64(), workspace.path().to_str().unwrap()).is_err());
        fs::remove_file(workspace.path().join("outputs")).unwrap();
        let image = save_base64_image(&png_base64(), workspace.path().to_str().unwrap()).unwrap();
        let protected = outside.path().join("protected");
        fs::write(&protected, b"unchanged").unwrap();
        fs::remove_file(image.saved_path()).unwrap();
        symlink(&protected, image.saved_path()).unwrap();
        save_base64_image(&png_base64(), workspace.path().to_str().unwrap()).unwrap();
        assert_eq!(fs::read(protected).unwrap(), b"unchanged");
        assert!(!fs::symlink_metadata(image.saved_path())
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn index_survives_reload_deduplicates_and_respects_pagination_and_child_history() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("generated-images/index.json");
        let image = delivery("ig-1", "child-turn");
        persist_delivery_at(&path, &image).unwrap();
        persist_delivery_at(&path, &image).unwrap();
        persist_delivery_at(&path, &delivery("ig-2", "other-turn")).unwrap();
        let entries = read_index(&path).unwrap(); // No in-memory cache.
        assert_eq!(entries.len(), 2);
        let mut page = json!({"id": "child", "turns": [{"id":"child-turn","items":[]}]});
        merge_entries(&entries, &mut page);
        merge_entries(&entries, &mut page);
        assert_eq!(page["turns"][0]["items"].as_array().unwrap().len(), 1);
        let mut child_with_native = json!({"id":"child","turns":[{"id":"child-turn","items":[
            {"id":"ig-1","type":"imageGeneration","savedPath":null}
        ]}]});
        merge_entries(&entries, &mut child_with_native);
        assert_eq!(
            child_with_native["turns"][0]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut parent = json!({"id":"root","turns":[{"id":"root-turn","items":[]}]});
        merge_entries(&entries, &mut parent);
        assert!(
            parent["turns"][0]["items"].as_array().unwrap().is_empty(),
            "Child artifacts belong to the child transcript, not the parent's final answer"
        );
        let mut unrelated = json!({"id":"other","turns":[{"id":"root-turn","items":[]}]});
        merge_entries(&entries, &mut unrelated);
        assert!(unrelated["turns"][0]["items"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn index_write_errors_are_not_success_and_corruption_is_not_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("index.json");
        fs::write(&path, b"corrupt").unwrap();
        assert!(persist_delivery_at(&path, &delivery("ig", "turn")).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"corrupt");
        assert!(persist_delivery_at(&path.join("index.json"), &delivery("ig", "turn")).is_err());
    }

    #[test]
    fn concurrent_deliveries_do_not_lose_index_entries() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("index.json");
        std::thread::scope(|scope| {
            for i in 0..12 {
                let path = &path;
                scope.spawn(move || {
                    persist_delivery_at(path, &delivery(&format!("ig-{i}"), "turn")).unwrap()
                });
            }
        });
        assert_eq!(read_index(&path).unwrap().len(), 12);
    }

    #[test]
    fn resolves_relative_and_tilde_workspaces() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("project")).unwrap();
        assert_eq!(
            canonical_workspace_with_root("project", root.path()).unwrap(),
            root.path().join("project").canonicalize().unwrap()
        );
        assert!(canonical_workspace_with_root("../outside", root.path()).is_err());
        assert_eq!(
            expand_home_path("~/Documents").unwrap(),
            dirs::home_dir().unwrap().join("Documents")
        );
    }

    #[test]
    fn pathless_native_completion_cannot_erase_a_delivered_attachment() {
        let root = tempfile::tempdir().unwrap();
        let artifact = save_base64_image(&png_base64(), root.path().to_str().unwrap()).unwrap();
        let mut delivery = delivery("ig", "child-turn");
        delivery.error = None;
        delivery.artifact = Some(artifact);
        let entries = vec![delivery];
        let mut native = json!({"method":"item/completed", "params":{
            "threadId":"child","turnId":"child-turn",
            "item":{"id":"ig","type":"imageGeneration","status":"completed","savedPath":null}
        }});
        enrich_from_entries(&entries, &mut native);
        assert!(native["params"]["item"]["savedPath"].is_string());
        assert!(native["params"]["item"]["deliveryError"].is_null());
        let mut unrelated = json!({"params":{
            "threadId":"child","turnId":"different-turn",
            "item":{"id":"ig","type":"imageGeneration","savedPath":null}
        }});
        enrich_from_entries(&entries, &mut unrelated);
        assert!(unrelated["params"]["item"]["savedPath"].is_null());
    }
}
