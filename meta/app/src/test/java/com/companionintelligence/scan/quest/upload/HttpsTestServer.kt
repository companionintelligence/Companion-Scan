package com.companionintelligence.scan.quest.upload

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import java.net.InetAddress

/** A MockWebServer speaking HTTPS with a throwaway certificate, and a client of the app's kind that trusts it. */
class HttpsTestServer {
    private val certificate = HeldCertificate.Builder()
        .addSubjectAlternativeName("localhost")
        .addSubjectAlternativeName("127.0.0.1")
        .build()
    val server = MockWebServer()
    val client: OkHttpClient

    init {
        val serverCertificates = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        server.useHttps(serverCertificates.sslSocketFactory(), false)
        server.start(InetAddress.getByName("localhost"), 0)
        val clientCertificates = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        client = ScanServerClient.httpsOnlyClientBuilder()
            .sslSocketFactory(clientCertificates.sslSocketFactory(), clientCertificates.trustManager)
            .build()
    }

    private var closed = false

    fun scanClient(path: String = "/") = ScanServerClient(server.url(path), client)

    fun close() {
        if (closed) return
        closed = true
        server.shutdown()
    }
}
