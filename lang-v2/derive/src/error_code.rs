//! `#[error_code]` — emits a cheap `From<E> for Error` that wraps the enum
//! discriminant as `ProgramError::Custom(code)`. The `#[msg("...")]` helper
//! is IDL-only metadata — never allocated at runtime.
//!
//! Intentionally does **not** port v1's `AnchorError` struct (heap-allocated
//! name + msg + file/line). V2 programs route error text through the IDL;
//! runtime strings duplicate that at non-trivial CU cost.

use {
    proc_macro::TokenStream,
    proc_macro2::TokenStream as TokenStream2,
    quote::{quote, ToTokens},
    syn::{
        parse_macro_input, Attribute, Expr, ItemEnum, Lit, Meta, MetaNameValue,
    },
};

/// Default first error code. Matches v1's `ERROR_CODE_OFFSET`.
const DEFAULT_OFFSET: u32 = 6000;

pub fn expand(args: TokenStream, input: TokenStream) -> TokenStream {
    let offset = match parse_offset(args.into()) {
        Ok(Some(offset)) => offset,
        Ok(None) => DEFAULT_OFFSET,
        Err(err) => return err.to_compile_error().into(),
    };
    let mut item = parse_macro_input!(input as ItemEnum);
    let name = item.ident.clone();

    let mut errors = Vec::new();
    let mut idl_entry_pushes = Vec::new();
    for variant in item.variants.iter_mut() {
        let message = match extract_msg(&variant.attrs) {
            Ok(message) => message,
            Err(err) => {
                errors.push(err.to_compile_error());
                None
            }
        };
        // Strip used `msg` attribute
        variant.attrs.retain(|a| !a.path().is_ident("msg"));
        if let Some((_, discr)) = &variant.discriminant {
            if parse_discrim(discr).is_none() {
                errors.push(
                    syn::Error::new_spanned(discr, "discriminant must be a u32 literal")
                        .to_compile_error(),
                );
                continue;
            }
        }
        let variant_ident = variant.ident.clone();
        let cfg_attrs = crate::cfg_attrs(&variant.attrs);
        let variant_name = variant.ident.to_string();
        let msg_field = match message {
            Some(message) => quote! {
                anchor_lang::__alloc::format!(
                    ",\"msg\":{}",
                    anchor_lang::idl_build::__idl_json_string(#message),
                )
            },
            None => quote! { "" },
        };
        idl_entry_pushes.push(quote! {
            #(#cfg_attrs)*
            {
                let __code = (#name::#variant_ident as u32)
                    .checked_add(#offset)
                    .expect("error code overflowed");
                __parts.push(anchor_lang::__alloc::format!(
                    "{{\"code\":{},\"name\":{}{}}}",
                    __code,
                    anchor_lang::idl_build::__idl_json_string(#variant_name),
                    #msg_field,
                ));
            }
        });
    }
    let idl_fn_name = quote::format_ident!(
        "__anchor_private_print_idl_errors_{}",
        name.to_string().to_lowercase()
    );

    let from_impl = quote! {
        impl From<#name> for anchor_lang::Error {
            #[inline(always)]
            fn from(e: #name) -> Self {
                // Guarenteed not to overflow in `build_idl_errors_json`
                anchor_lang::Error::Custom(e as u32 + #offset)
            }
        }
    };

    // `__idl_errors()` mirrors `__idl_accounts()` (lang-v2/derive/src/idl.rs):
    // a `pub fn` on the type returning the IDL JSON string. Lets the existing
    // `mod idl_tests { ... }` style suites parse the output with
    // `serde_json::from_str::<Vec<IdlErrorCode>>()` instead of capturing
    // stdout from the `__anchor_private_print_idl_errors_*` test fn.
    let idl_print = quote! {
        #[cfg(feature = "idl-build")]
        impl #name {
            #[doc(hidden)]
            pub fn __idl_errors() -> anchor_lang::__alloc::string::String {
                let mut __parts: anchor_lang::__alloc::vec::Vec<
                    anchor_lang::__alloc::string::String
                > = anchor_lang::__alloc::vec::Vec::new();
                #(#idl_entry_pushes)*
                let mut __payload = anchor_lang::__alloc::string::String::from("[");
                let mut __first = true;
                for __part in &__parts {
                    if !__first {
                        __payload.push(',');
                    }
                    __first = false;
                    __payload.push_str(__part);
                }
                __payload.push(']');
                __payload
            }
        }

        #[cfg(all(test, feature = "idl-build"))]
        #[test]
        fn #idl_fn_name() {
            println!("--- IDL begin errors ---");
            println!("{}", #name::__idl_errors());
            println!("--- IDL end errors ---");
        }
    };

    TokenStream::from(quote! {
        #[repr(u32)]
        #[derive(Clone, Copy)]
        #item

        #from_impl
        #idl_print
        #(#errors)*
    })
}

fn parse_offset(args: TokenStream2) -> syn::Result<Option<u32>> {
    if args.is_empty() {
        return Ok(None);
    }
    let meta: MetaNameValue = syn::parse2(args)?;
    if !meta.path.is_ident("offset") {
        return Err(syn::Error::new_spanned(
            &meta.path,
            format!(
                "unknown `#[error_code]` argument `{}`; expected `offset = N`",
                meta.path.to_token_stream()
            ),
        ));
    }
    match &meta.value {
        Expr::Lit(syn::ExprLit {
            lit: Lit::Int(i), ..
        }) => i
            .base10_parse::<u32>()
            .map(Some)
            .map_err(|_| syn::Error::new_spanned(i, "`offset` must be a u32 integer literal")),
        _ => Err(syn::Error::new_spanned(
            &meta.value,
            "`offset` must be a u32 integer literal",
        )),
    }
}

fn parse_discrim(discrim: &Expr) -> Option<u32> {
    match discrim {
        Expr::Lit(syn::ExprLit {
            lit: Lit::Int(i), ..
        }) => i.base10_parse::<u32>().ok(),
        _ => None,
    }
}

fn extract_msg(attrs: &[Attribute]) -> syn::Result<Option<String>> {
    let mut message = None;
    for attr in attrs {
        if !attr.path().is_ident("msg") {
            continue;
        }
        let list = match &attr.meta {
            Meta::List(list) => list,
            _ => {
                return Err(syn::Error::new_spanned(
                    attr,
                    r#"expected `#[msg("...")]`"#,
                ));
            }
        };
        let lit: Lit = syn::parse2(list.tokens.clone()).map_err(|_| {
            syn::Error::new_spanned(attr, r#"expected `#[msg("...")]`"#)
        })?;
        let Lit::Str(s) = lit else {
            return Err(syn::Error::new_spanned(
                attr,
                r#"expected `#[msg("...")]`"#,
            ));
        };
        if message.is_some() {
            return Err(syn::Error::new_spanned(attr, "duplicate `#[msg]` attribute"));
        }
        message = Some(s.value());
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_offset_accepts_offset_assignment() {
        let offset = parse_offset(quote!(offset = 7000)).expect("offset arg should parse");

        assert_eq!(offset, Some(7000));
    }

    #[test]
    fn parse_offset_rejects_unknown_argument() {
        let err = parse_offset(quote!(unknown = 7000)).unwrap_err();

        assert!(
            err.to_string()
                .contains("unknown `#[error_code]` argument `unknown`"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn parse_offset_rejects_non_integer_literal() {
        let err = parse_offset(quote!(offset = "oops")).unwrap_err();

        assert!(
            err.to_string()
                .contains("`offset` must be a u32 integer literal"),
            "unexpected error: {err}"
        );
    }

    fn variant_attrs(tokens: TokenStream2) -> Vec<Attribute> {
        let item: ItemEnum = syn::parse2(tokens).expect("enum should parse");
        item.variants
            .into_iter()
            .next()
            .expect("enum should have a variant")
            .attrs
    }

    #[test]
    fn extract_msg_accepts_string_literal() {
        let attrs = variant_attrs(quote! {
            enum E {
                #[msg("boom")]
                A,
            }
        });
        assert_eq!(extract_msg(&attrs).unwrap(), Some("boom".into()));
    }

    #[test]
    fn extract_msg_accepts_missing_msg() {
        let attrs = variant_attrs(quote! {
            enum E {
                A,
            }
        });
        assert_eq!(extract_msg(&attrs).unwrap(), None);
    }

    #[test]
    fn extract_msg_rejects_name_value() {
        let attrs = variant_attrs(quote! {
            enum E {
                #[msg = "oops"]
                A,
            }
        });
        let err = extract_msg(&attrs).unwrap_err();
        assert!(
            err.to_string().contains(r#"expected `#[msg("...")]`"#),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn extract_msg_rejects_path_form() {
        let attrs = variant_attrs(quote! {
            enum E {
                #[msg]
                A,
            }
        });
        let err = extract_msg(&attrs).unwrap_err();
        assert!(
            err.to_string().contains(r#"expected `#[msg("...")]`"#),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn extract_msg_rejects_multiple_arguments() {
        let attrs = variant_attrs(quote! {
            enum E {
                #[msg("a", "b")]
                A,
            }
        });
        let err = extract_msg(&attrs).unwrap_err();
        assert!(
            err.to_string().contains(r#"expected `#[msg("...")]`"#),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn extract_msg_rejects_identifier() {
        let attrs = variant_attrs(quote! {
            enum E {
                #[msg(SOME_CONST)]
                A,
            }
        });
        let err = extract_msg(&attrs).unwrap_err();
        assert!(
            err.to_string().contains(r#"expected `#[msg("...")]`"#),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn extract_msg_rejects_integer_literal() {
        let attrs = variant_attrs(quote! {
            enum E {
                #[msg(1)]
                A,
            }
        });
        let err = extract_msg(&attrs).unwrap_err();
        assert!(
            err.to_string().contains(r#"expected `#[msg("...")]`"#),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn extract_msg_rejects_duplicate() {
        let attrs = variant_attrs(quote! {
            enum E {
                #[msg("a")]
                #[msg("b")]
                A,
            }
        });
        let err = extract_msg(&attrs).unwrap_err();
        assert!(
            err.to_string().contains("duplicate `#[msg]` attribute"),
            "unexpected error: {err}"
        );
    }
}
