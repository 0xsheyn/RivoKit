// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Subset ERC-20 yang dipakai escrow.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title RivoEscrow — escrow non-custodial untuk order marketplace.
 *
 * @dev INVARIANT INTI (CLAUDE.md #1, CONCEPT §12):
 *      kontrak hanya boleh mengirim dana ke `order.payer` atau `order.payee`,
 *      keduanya dipatok saat order dibuat. `_release`/`_refund` TIDAK menerima
 *      parameter alamat tujuan. Platform berperan sebagai RELAYER (submit tx,
 *      bayar gas) — BUKAN otorisator. Relayer atau arbiter yang dikompromikan
 *      hanya bisa salah-arahkan di antara payer/payee, tak pernah ke pihak ketiga.
 *
 * @dev BELUM DIAUDIT — MVP hackathon. Jangan gunakan dengan dana nyata.
 */
contract RivoEscrow {
    enum State {
        None,
        Open,
        Funded,
        Shipped,
        Disputed,
        Released,
        Refunded
    }

    struct Order {
        address payer; // terkunci saat fund()
        address payee; // dipatok saat open()
        address arbiter; // per-order; address(0) = timeout-only
        address token; // USDC
        uint256 amount;
        uint64 shipDeadline; // T_ship
        uint64 confirmWindow; // T_confirm, dihitung dari shippedAt
        uint64 shippedAt;
        State state;
    }

    mapping(bytes32 => Order) private _orders;

    /// @dev Atribusi kriptografis: `msg.sender` pembayar tercatat per orderId,
    ///      sehingga dua deposit kembar tetap terpisah tanpa memo/invoice.
    event Deposited(bytes32 indexed orderId, address indexed payer, uint256 amount);
    event Opened(bytes32 indexed orderId, address indexed payee, uint256 amount);
    event Shipped(bytes32 indexed orderId, uint64 shippedAt);
    event Released(bytes32 indexed orderId, address indexed payee, uint256 amount);
    event Refunded(bytes32 indexed orderId, address indexed payer, uint256 amount);
    event Disputed(bytes32 indexed orderId, address indexed by);

    error OrderExists();
    error OrderMissing();
    error BadState();
    error NotAuthorized();
    error TooEarly();
    error TransferFailed();
    error Reentrancy();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    /// @notice Buat order. Tujuan dana (payee) dipatok DI SINI dan tak bisa diubah.
    function open(
        bytes32 orderId,
        address payee,
        address arbiter,
        address token,
        uint256 amount,
        uint64 shipDeadline,
        uint64 confirmWindow
    ) external {
        if (_orders[orderId].state != State.None) revert OrderExists();
        _orders[orderId] = Order({
            payer: address(0),
            payee: payee,
            arbiter: arbiter,
            token: token,
            amount: amount,
            shipDeadline: shipDeadline,
            confirmWindow: confirmWindow,
            shippedAt: 0,
            state: State.Open
        });
        emit Opened(orderId, payee, amount);
    }

    /// @notice Pembeli mendanai escrow. `payer` terkunci pada pemanggil — set-once.
    /// @dev TODO(M1): terima EIP-3009 `transferWithAuthorization` agar relayer bisa
    ///      submit atas nama pembeli tanpa pembeli memegang gas.
    function fund(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.state == State.None) revert OrderMissing();
        if (o.state != State.Open) revert BadState();

        o.payer = msg.sender;
        o.state = State.Funded;

        if (!IERC20(o.token).transferFrom(msg.sender, address(this), o.amount)) {
            revert TransferFailed();
        }
        emit Deposited(orderId, msg.sender, o.amount);
    }

    /// @notice Penjual menandai barang terkirim — memulai jam T_confirm.
    function markShipped(bytes32 orderId) external {
        Order storage o = _orders[orderId];
        if (o.state != State.Funded) revert BadState();
        if (msg.sender != o.payee) revert NotAuthorized();

        o.shippedAt = uint64(block.timestamp);
        o.state = State.Shipped;
        emit Shipped(orderId, o.shippedAt);
    }

    /// @notice Pembeli mengonfirmasi terima → rilis ke penjual.
    function confirmReceipt(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.state != State.Funded && o.state != State.Shipped) revert BadState();
        if (msg.sender != o.payer) revert NotAuthorized();
        _release(orderId, o);
    }

    /// @notice Timeout konfirmasi lewat → siapa pun (relayer) boleh memicu rilis.
    function autoRelease(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.state != State.Shipped) revert BadState();
        if (block.timestamp <= uint256(o.shippedAt) + uint256(o.confirmWindow)) revert TooEarly();
        _release(orderId, o);
    }

    /// @notice Penjual tak kunjung mengirim → siapa pun boleh memulangkan dana pembeli.
    function claimRefund(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.state != State.Funded) revert BadState();
        if (block.timestamp <= o.shipDeadline) revert TooEarly();
        _refund(orderId, o);
    }

    /// @notice Penjual membatalkan sendiri sebelum rilis.
    function refund(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.state != State.Funded && o.state != State.Shipped) revert BadState();
        if (msg.sender != o.payee) revert NotAuthorized();
        _refund(orderId, o);
    }

    /// @notice Bekukan order selama sengketa. Tak memindahkan dana.
    function dispute(bytes32 orderId) external {
        Order storage o = _orders[orderId];
        if (o.state != State.Shipped) revert BadState();
        if (msg.sender != o.payer && msg.sender != o.payee) revert NotAuthorized();

        o.state = State.Disputed;
        emit Disputed(orderId, msg.sender);
    }

    /// @notice Arbiter memutuskan. Pilihannya HANYA payee atau payer — tak ada
    ///         alamat ketiga yang bisa disebutkan.
    function resolve(bytes32 orderId, bool toPayee) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.state != State.Disputed) revert BadState();
        if (o.arbiter == address(0) || msg.sender != o.arbiter) revert NotAuthorized();

        if (toPayee) _release(orderId, o);
        else _refund(orderId, o);
    }

    // --- internal: TANPA parameter alamat; tujuan diambil dari struct order ---

    function _release(bytes32 orderId, Order storage o) private {
        o.state = State.Released; // checks-effects-interactions
        address to = o.payee;
        uint256 amount = o.amount;
        if (!IERC20(o.token).transfer(to, amount)) revert TransferFailed();
        emit Released(orderId, to, amount);
    }

    function _refund(bytes32 orderId, Order storage o) private {
        o.state = State.Refunded;
        address to = o.payer;
        uint256 amount = o.amount;
        if (!IERC20(o.token).transfer(to, amount)) revert TransferFailed();
        emit Refunded(orderId, to, amount);
    }
}
