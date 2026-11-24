package com.companionintelligence.scan.quest.splat

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SplatSourceTest {
    private val server = "https://scan.example.ts.net/".toHttpUrl()

    private fun remote(input: String) = SplatSource.resolve(input, server) as SplatSource.Resolved.Remote

    private fun refused(input: String, base: okhttp3.HttpUrl? = server) =
        (SplatSource.resolve(input, base) as SplatSource.Resolved.Refused).reason

    @Test
    fun aBareNameIsFetchedFromTheScansRoute() {
        val r = remote("kitchen.splat.ply")
        assertEquals("https://scan.example.ts.net/scans/kitchen.splat.ply", r.url.toString())
        assertEquals("kitchen.splat.ply", r.fileName)
    }

    @Test
    fun aFullHttpsUrlIsTakenAsItIs() {
        assertEquals("https://other.example/x/room.spz", remote("https://other.example/x/room.spz").url.toString())
    }

    @Test
    fun onlyThePlyAndSpzFormatsTheSdkListsAreTried() {
        assertTrue(refused("kitchen.compressed.ply").contains("compressed"))
        assertTrue(refused("kitchen.sog").contains("SOG"))
        refused("kitchen.glb")
        assertNull(SplatSource.acceptance("Kitchen.SPLAT.PLY"))
        assertNull(SplatSource.acceptance("room.spz"))
    }

    @Test
    fun aNameAskedOfTheServerMustBeOneItServes() {
        // GET /scans/:filename serves <scan>.splat.ply; a plain .ply or an .spz falls to the .glb-only route (FN-174).
        assertTrue(refused("kitchen.ply").contains("splat.ply"))
        assertTrue(refused("kitchen.spz").contains("splat.ply"))
        assertTrue(refused("https://scan.example.ts.net/scans/kitchen.ply").contains("splat.ply"))
        assertEquals("https://scan.example.ts.net/scans/kitchen.splat.ply", remote("https://scan.example.ts.net/scans/kitchen.splat.ply").url.toString())
        // Another host, or another path on this one, is not the scans route: the SDK's own formats are tried.
        assertEquals("https://other.example/x/room.ply", remote("https://other.example/x/room.ply").url.toString())
        assertEquals("https://scan.example.ts.net/files/room.ply", remote("https://scan.example.ts.net/files/room.ply").url.toString())
        // A server behind a path prefix: its scans route is under the prefix.
        val prefixed = "https://scan.example.ts.net/scan/".toHttpUrl()
        assertTrue((SplatSource.resolve("https://scan.example.ts.net/scan/scans/a.ply", prefixed) as SplatSource.Resolved.Refused).reason.contains("splat.ply"))
        assertTrue(SplatSource.resolve("a.splat.ply", prefixed) is SplatSource.Resolved.Remote)
        // A local file is read by the SDK, not served: .ply and .spz both.
        assertNull(SplatSource.acceptance("room.ply"))
        assertNull(SplatSource.acceptance("room.spz"))
    }

    @Test
    fun httpPathsAndMissingServersAreRefused() {
        assertTrue(refused("http://scan.example.ts.net/scans/a.ply").contains("http://"))
        refused("ftp://scan.example.ts.net/a.ply")
        refused("../a.ply")
        refused("dir/a.ply")
        refused("a.splat.ply", base = null)
        refused("")
    }

    @Test
    fun localFileNamesAreSanitised() {
        assertEquals("my_room_.splat.ply", SplatSource.safeFileName("my room?.splat.ply"))
        assertEquals("hidden.ply", SplatSource.safeFileName("..hidden.ply"))
    }
}
