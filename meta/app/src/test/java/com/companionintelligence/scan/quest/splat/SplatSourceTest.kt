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
