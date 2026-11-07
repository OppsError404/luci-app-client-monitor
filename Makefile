include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-client-monitor
PKG_VERSION:=1.0.0
PKG_RELEASE:=3
PKG_LICENSE:=MIT
PKG_MAINTAINER:=Mahid
PKG_URL:=https://github.com/OppsError404/luci-app-client-monitor

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-client-monitor
  SECTION:=luci
  CATEGORY:=LuCI
  TITLE:=Client Monitor
  DEPENDS:=+luci-base +luci-lib-jsonc +lua +luci-lib-nixio +libubus-lua +libuci-lua
  PKGARCH:=all
endef

define Package/luci-app-client-monitor/description
  A real-time client usage monitoring UI for OpenWrt LuCI.
endef

LUCI_TMPL_DIR:=/usr/share/ucode/luci/template/client_monitor
PKG_STORE:=/usr/lib/lua/luci/client_monitor_pkg
RPCD_DIR:=/usr/libexec/rpcd
CM_VIEW_RES:=/www/luci-static/resources/view/client_monitor
LUCI_MENU_DIR:=/usr/share/luci/menu.d
RPCD_ACL_DIR:=/usr/share/rpcd/acl.d

define Build/Configure
endef

define Build/Compile
	# Use gzip -n for reproducible assets; init unpacks them into RAM.
	find $(PKG_BUILD_DIR)$(CM_VIEW_RES) \
		-type f ! -name '*.gz' -exec gzip -9n -kf {} +
endef

define Package/luci-app-client-monitor/install
	$(INSTALL_DIR) $(1)$(LUCI_TMPL_DIR) $(1)$(PKG_STORE) \
		$(1)$(RPCD_DIR) $(1)$(CM_VIEW_RES) \
		$(1)$(LUCI_MENU_DIR) $(1)$(RPCD_ACL_DIR) \
		$(1)/etc/init.d $(1)/etc/hotplug.d/net $(1)/usr/bin $(1)/usr/sbin

	$(INSTALL_DATA) $(PKG_BUILD_DIR)$(LUCI_TMPL_DIR)/*.ut $(1)$(LUCI_TMPL_DIR)/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)$(PKG_STORE)/*.lua $(1)$(PKG_STORE)/

	# Ship only the compressed assets.
	$(INSTALL_DATA) $(PKG_BUILD_DIR)$(CM_VIEW_RES)/*.gz $(1)$(CM_VIEW_RES)/

	# Register the LuCI page and its RPC permissions.
	$(INSTALL_DATA) $(PKG_BUILD_DIR)$(LUCI_MENU_DIR)/luci-app-client-monitor.json \
		$(1)$(LUCI_MENU_DIR)/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)$(RPCD_ACL_DIR)/luci-app-client-monitor.json \
		$(1)$(RPCD_ACL_DIR)/

	# Install the data and refresh handlers for rpcd.
	$(INSTALL_BIN) $(PKG_BUILD_DIR)$(RPCD_DIR)/client_monitor $(1)$(RPCD_DIR)/

	$(INSTALL_BIN) $(PKG_BUILD_DIR)/etc/init.d/client_monitor \
		$(1)/etc/init.d/

	$(INSTALL_BIN) $(PKG_BUILD_DIR)/etc/hotplug.d/net/99-client-monitor \
		$(1)/etc/hotplug.d/net/

	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/bin/ap_monitor $(1)/usr/bin/

	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/sbin/client_monitor_collect \
		$(1)/usr/sbin/
endef

define Package/luci-app-client-monitor/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0

rm -f /tmp/luci-indexcache /tmp/luci-modulecache /tmp/luci-*cache* 2>/dev/null || true

if [ -f /etc/init.d/client_monitor.apk-new ]; then
    mv /etc/init.d/client_monitor.apk-new /etc/init.d/client_monitor
fi
if [ -f /etc/init.d/client_monitor.opkg-new ]; then
    mv /etc/init.d/client_monitor.opkg-new /etc/init.d/client_monitor
fi

# default_postinst enables the service at boot; restart reloads the RAM assets.
/etc/init.d/client_monitor restart 2>/dev/null || true

/etc/init.d/rpcd restart 2>/dev/null || true

exit 0
endef

define Package/luci-app-client-monitor/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$${PKG_UPGRADE}" = "1" ] && exit 0
[ "$$1" = "upgrade" ] && exit 0

# default_prerm has already stopped and disabled the service.
for asset in /www/luci-static/resources/view/client_monitor/*; do
    [ -L "$$asset" ] || continue
    if [ "$$(readlink "$$asset")" = "/tmp/luci-static/resources/view/client_monitor/$${asset##*/}" ]; then
        rm -f "$$asset"
    fi
done

rm -rf /tmp/client_monitor /tmp/luci-static/resources/view/client_monitor 2>/dev/null || true

rmdir /usr/share/ucode/luci/template/client_monitor 2>/dev/null || true
rmdir /usr/lib/lua/luci/client_monitor_pkg 2>/dev/null || true
rmdir /www/luci-static/resources/view/client_monitor 2>/dev/null || true

rm -f /tmp/luci-indexcache /tmp/luci-modulecache /tmp/luci-*cache* 2>/dev/null || true
/etc/init.d/rpcd restart 2>/dev/null || true

exit 0
endef

$(eval $(call BuildPackage,luci-app-client-monitor))
