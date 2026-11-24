"""Reference values for tests/unit/deno/georef_vectors.test.ts, derived without src/world/enu.ts.

Run:  python3 -I -B tests/unit/deno/georef_reference.py

Nothing here imports or ports the module under test. Every number below is computed in 70-digit `decimal` arithmetic from
the textbook closed forms for the WGS-84 ellipsoid (a = 6378137 m, 1/f = 298.257223563: EPSG methods 9602, geographic to
geocentric, and 9836, geocentric to topocentric, as IOGP Guidance Note 7-2 states them), with the trigonometry written out
below as Taylor series so no float library is involved. It checks the module's double-precision arithmetic to a few
nanometres, which is the "70-digit vectors" of the georeference plan, and it reproduces IOGP's two published worked
examples to the millimetre they print, which checks the formulas and not only the arithmetic.

Three things are produced:

1. The two IOGP GN 7-2 worked examples (published, printed to the millimetre), against this script's exact values:
   - geographic to geocentric: WGS84 53 48 33.82 N, 2 07 46.38 E, h 73.00 m -> X 3771793.968, Y 140253.342, Z 5124304.349;
   - geocentric to topocentric: origin 3652755.3058, 319574.6799, 5201547.3536 (geodetic 55 N, 5 E, h 200 m), the point
     above -> E -189013.869, N -128642.040, U -4220.171.
2. Six origin/target pairs (Singapore, London, Sydney, Tromso, Fiji across the antimeridian, Wellington): east, north, up.
3. Inverse offsets from a London origin: the geodetic position of a point a given east, north and up away (a Newton solve
   of the forward map, started from a float64 guess and run to 70 digits).

The expected numbers in the test file were pasted from this output.
"""
from decimal import Decimal as D, getcontext
import math

getcontext().prec = 70

PI = D('3.14159265358979323846264338327950288419716939937510582097494459230781640628620899')
A = D(6378137)
F = D(1) / D('298.257223563')
E2 = F * (2 - F)


def sin_cos(x):
    """Taylor series, after reducing x to [-pi, pi]."""
    two_pi = 2 * PI
    x = x - two_pi * ((x / two_pi).to_integral_value())
    s, c = D(0), D(0)
    term_s, term_c = x, D(1)
    for n in range(0, 80):
        if n > 0:
            term_c = term_c * (-x * x) / ((2 * n - 1) * (2 * n))
            term_s = term_s * (-x * x) / ((2 * n) * (2 * n + 1))
        c += term_c
        s += term_s
    return s, c


def rad(deg):
    return D(deg) * PI / 180


def ecef(lat, lng, h):
    """EPSG 9602: geographic (degrees, metres) to geocentric."""
    slat, clat = sin_cos(rad(lat))
    slng, clng = sin_cos(rad(lng))
    n = A / (1 - E2 * slat * slat).sqrt()
    return ((n + D(h)) * clat * clng, (n + D(h)) * clat * slng, (n * (1 - E2) + D(h)) * slat)


def topocentric(origin_ecef, origin_lat, origin_lng, point_ecef):
    """EPSG 9836: geocentric to topocentric (east, north, up) about an origin whose geocentric position and rotation angles are given."""
    ox, oy, oz = origin_ecef
    px, py, pz = point_ecef
    dx, dy, dz = px - ox, py - oy, pz - oz
    slat, clat = sin_cos(rad(origin_lat))
    slng, clng = sin_cos(rad(origin_lng))
    east = -slng * dx + clng * dy
    north = -slat * clng * dx - slat * slng * dy + clat * dz
    up = clat * clng * dx + clat * slng * dy + slat * dz
    return east, north, up


def enu(origin, point):
    return topocentric(ecef(*origin), origin[0], origin[1], ecef(*point))


def inverse(origin, east, north, up):
    """The geodetic position `east, north, up` metres from `origin`, by Newton's method on the forward map."""
    slat, clat = sin_cos(rad(origin[0]))
    slng, clng = sin_cos(rad(origin[1]))
    ox, oy, oz = ecef(*origin)
    target = (
        ox - east * slng - north * slat * clng + up * clat * clng,
        oy + east * clng - north * slat * slng + up * clat * slng,
        oz + north * clat + up * slat,
    )
    # A float64 start, then Newton steps in 70 digits. The east, north and up directions at the current estimate are
    # orthogonal, so the Jacobian is diagonal in them: each step is three dot products.
    x, y, z = (float(c) for c in target)
    lng = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - float(E2)))
    h = 0.0
    lat_d, lng_d, h_d = D(lat) * 180 / PI, D(lng) * 180 / PI, D(h)
    for _ in range(8):
        sphi, cphi = sin_cos(rad(lat_d))
        slam, clam = sin_cos(rad(lng_d))
        w = (1 - E2 * sphi * sphi).sqrt()
        prime_vertical = A / w
        meridian = A * (1 - E2) / (w * w * w)
        cx, cy, cz = ecef(lat_d, lng_d, h_d)
        dx, dy, dz = target[0] - cx, target[1] - cy, target[2] - cz
        e_hat = (-slam, clam, D(0))
        n_hat = (-sphi * clam, -sphi * slam, cphi)
        u_hat = (cphi * clam, cphi * slam, sphi)
        d_east = dx * e_hat[0] + dy * e_hat[1] + dz * e_hat[2]
        d_north = dx * n_hat[0] + dy * n_hat[1] + dz * n_hat[2]
        d_up = dx * u_hat[0] + dy * u_hat[1] + dz * u_hat[2]
        lat_d += (d_north / (meridian + h_d)) * 180 / PI
        lng_d += (d_east / ((prime_vertical + h_d) * cphi)) * 180 / PI
        h_d += d_up
    return lat_d, lng_d, h_d


def num(x, digits=15):
    if isinstance(x, D):
        return '0' if abs(x) < D('1e-30') else format(x, f'.{digits}e')
    return repr(x)


def dms(deg, minutes, seconds):
    return D(deg) + D(minutes) / 60 + D(seconds) / 3600


# IOGP GN 7-2, geographic to geocentric: 53 48 33.82 N, 2 07 46.38 E, 73.00 m. Printed X 3771793.968, Y 140253.342, Z 5124304.349.
IOGP_LAT = dms(53, 48, '33.82')
IOGP_LNG = dms(2, 7, '46.38')
IOGP_H = D('73.00')
# IOGP GN 7-2, geocentric to topocentric. The origin is given as geocentric coordinates and is geodetic 55 N, 5 E, h 200 m
# (the printed geocentric values round those). Printed result E -189013.869, N -128642.040, U -4220.171.
TOPO_ORIGIN_ECEF = (D('3652755.3058'), D('319574.6799'), D('5201547.3536'))
TOPO_ORIGIN_LAT = D(55)
TOPO_ORIGIN_LNG = D(5)
TOPO_ORIGIN_H = D(200)
TOPO_POINT_ECEF = (D('3771793.968'), D('140253.342'), D('5124304.349'))

# (name, origin lat, lng, h, target lat, lng, h)
PAIRS = [
    ('singapore', '1.3521', '103.8198', '15.0', '1.3530', '103.8210', '17.5'),
    ('london', '51.5007', '-0.1246', '11.0', '51.5010', '-0.1240', '12.0'),
    ('sydney', '-33.8568', '151.2153', '5.0', '-33.8570', '151.2150', '5.0'),
    ('tromso', '69.6492', '18.9553', '10.0', '69.6495', '18.9560', '10.0'),
    ('fiji_antimeridian', '-16.5000', '179.9999', '20.0', '-16.5001', '-179.9999', '20.0'),
    ('wellington', '-41.2865', '174.7762', '30.0', '-41.2860', '174.7770', '35.0'),
]

# Inverse offsets from the London origin: (east, north, up).
INVERSE_ORIGIN = (D('51.5007'), D('-0.1246'), D('11.0'))
INVERSE_OFFSETS = [(100, 0, 0), (0, 100, 0), (0, 0, 10), (30, -40, 2)]

if __name__ == '__main__':
    x, y, z = ecef(IOGP_LAT, IOGP_LNG, IOGP_H)
    print('// IOGP GN 7-2 geographic to geocentric: this script (exact) against the printed 3771793.968, 140253.342, 5124304.349')
    print(f'  exact:     [{num(x)}, {num(y)}, {num(z)}]')
    print(f'  geodetic input in degrees: {num(IOGP_LAT, 20)}, {num(IOGP_LNG, 20)}')
    print()
    e, n, u = topocentric(TOPO_ORIGIN_ECEF, TOPO_ORIGIN_LAT, TOPO_ORIGIN_LNG, TOPO_POINT_ECEF)
    print('// IOGP GN 7-2 geocentric to topocentric from the printed geocentric values: against the printed -189013.869, -128642.040, -4220.171')
    print(f'  printed inputs: [{num(e)}, {num(n)}, {num(u)}]')
    e, n, u = enu((TOPO_ORIGIN_LAT, TOPO_ORIGIN_LNG, TOPO_ORIGIN_H), (IOGP_LAT, IOGP_LNG, IOGP_H))
    print('// the same, from the geodetic origin (55 N, 5 E, 200 m) and the geodetic point')
    print(f'  geodetic:       [{num(e)}, {num(n)}, {num(u)}]')
    print()
    print('// six origin/target pairs: [name, [origin lat, lng, h], [target lat, lng, h], [east, north, up]]  (scene = east, up, -north)')
    for name, olat, olng, oh, tlat, tlng, th in PAIRS:
        e, n, u = enu((D(olat), D(olng), D(oh)), (D(tlat), D(tlng), D(th)))
        print(f"  ['{name}', [{olat}, {olng}, {oh}], [{tlat}, {tlng}, {th}], [{num(e)}, {num(n)}, {num(u)}]],")
    print()
    print('// the same six pairs with BOTH heights set to 0, which is how a Place is placed (the Place floor is the height; a vertical')
    print('// offset is never read from an altitude): [name, [east, north]]. The pairs above differ from these by about 2e-6 of the offset per metre of height.')
    for name, olat, olng, oh, tlat, tlng, th in PAIRS:
        e, n, u = enu((D(olat), D(olng), D(0)), (D(tlat), D(tlng), D(0)))
        print(f"  ['{name}', [{num(e)}, {num(n)}]],")
    print()
    print('// inverse offsets from london (51.5007, -0.1246, 11.0): [[east, north, up], [lat, lng, h]]')
    for east, north, up in INVERSE_OFFSETS:
        lat, lng, h = inverse(INVERSE_ORIGIN, D(east), D(north), D(up))
        print(f'  [[{east}, {north}, {up}], [{num(lat, 20)}, {num(lng, 20)}, {num(h)}]],')
    print()
    # The MathWorks enu2ecef example, which the test checks coarsely against the printed km and to 1e-6 m by a round trip.
    mw_origin = (D('45.9132'), D('36.7484'), D('1877753.2'))
    lat, lng, h = inverse(mw_origin, D('355601.3'), D('-923083.2'), D('1041016.4'))
    px, py, pz = ecef(lat, lng, h)
    print('// MathWorks enu2ecef documentation: origin 45.9132, 36.7484, 1877753.2 m; ENU 355601.3, -923083.2, 1041016.4 -> ECEF, metres')
    print(f'  [{num(px)}, {num(py)}, {num(pz)}]  (printed 5.5075e3, 4.5562e3, 6.0128e3 km)')
