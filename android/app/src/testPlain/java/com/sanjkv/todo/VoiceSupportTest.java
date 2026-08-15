package com.sanjkv.todo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;

/**
 * Covers the plain flavour's tidy-up of a model left behind by the voice
 * flavour.
 *
 * <p>In src/testPlain rather than src/test because the two flavours have
 * different VoiceSupport classes and only this one has deleteTree — a shared
 * test would fail to compile against the voice variant. {@code npm run
 * test:android} runs testPlainDebugUnitTest, so this is already wired in.
 *
 * <p>deleteTree is the only part reachable without a Context, and it is the
 * part with something to get wrong: the recursion, and not throwing on the
 * paths where there is nothing to delete.
 */
public class VoiceSupportTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    /** The shape Vosk actually leaves behind: model/model-en/{am,conf,...}. */
    private File unpackedModel() throws IOException {
        File root = temp.newFolder("model");
        File model = new File(root, "model-en");
        assertTrue(new File(model, "am").mkdirs());
        assertTrue(new File(model, "conf").mkdirs());
        assertTrue(new File(model, "ivector").mkdirs());
        write(new File(model, "uuid"), "en-in-0.4-todoapp-1");
        write(new File(model, "am/final.mdl"), "binary-ish");
        write(new File(model, "conf/model.conf"), "--min-active=200");
        write(new File(model, "ivector/final.ie"), "more");
        return root;
    }

    private static void write(File file, String text) throws IOException {
        java.nio.file.Files.write(file.toPath(), text.getBytes("UTF-8"));
    }

    @Test
    public void removesAnUnpackedModelWholesale() throws IOException {
        File root = unpackedModel();
        assertTrue("fixture should exist", root.isDirectory());

        assertTrue("reports the root is gone", VoiceSupport.deleteTree(root));
        assertFalse("nothing left on disk", root.exists());
    }

    @Test
    public void leavesSiblingsAlone() throws IOException {
        File root = unpackedModel();
        // tasks.json lives in getFilesDir(), not here, but the point stands:
        // only the directory it is given may go.
        File sibling = temp.newFile("keep-me.json");

        VoiceSupport.deleteTree(root);

        assertFalse(root.exists());
        assertTrue("a sibling of the model directory survives", sibling.exists());
    }

    @Test
    public void deletesAPlainFile() throws IOException {
        File file = temp.newFile("lonely.mdl");
        assertTrue(VoiceSupport.deleteTree(file));
        assertFalse(file.exists());
    }

    /** The ordinary case on the second and every later launch. */
    @Test
    public void missingDirectoryIsNotAnError() {
        File absent = new File(temp.getRoot(), "model");
        assertFalse("nothing to delete, so nothing deleted", VoiceSupport.deleteTree(absent));
    }

    @Test
    public void emptyDirectoryGoes() throws IOException {
        File empty = temp.newFolder("model");
        assertTrue(VoiceSupport.deleteTree(empty));
        assertFalse(empty.exists());
    }

    /** Deep enough to prove the recursion is not single-level. */
    @Test
    public void recursesBeyondOneLevel() throws IOException {
        File root = temp.newFolder("model");
        File deep = new File(root, "a/b/c/d");
        assertTrue(deep.mkdirs());
        write(new File(deep, "leaf.txt"), "x");

        assertTrue(VoiceSupport.deleteTree(root));
        assertFalse(root.exists());
        assertEquals("temp root itself untouched", true, temp.getRoot().isDirectory());
    }
}
